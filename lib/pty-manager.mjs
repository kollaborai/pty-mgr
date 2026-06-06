#!/usr/bin/env bun
/**
 * pty-manager.mjs - PTY-based agent session manager
 *
 * Uses:
 *   - Bun.spawn        native PTY support (no python, no native addons)
 *   - @xterm/headless   terminal emulator (parses escape codes into screen)
 *
 * capture() returns the actual rendered screen state, not raw output.
 * spinners, progress bars, cursor movements, and TUI redraws are all
 * resolved into clean text.
 *
 * API:
 *   mgr.spawn(name, cmd)       create session
 *   mgr.sendKeys(name, text)   send keystrokes
 *   mgr.capture(name, lines)   capture rendered screen
 *   mgr.has(name)              check if session exists
 *   mgr.kill(name)             kill session
 *   mgr.list()                 list sessions
 *   mgr.pid(name)              get child process pid
 *
 * Usage:
 *   import { PtyManager } from './pty-manager.mjs';
 *   const mgr = new PtyManager();
 *   mgr.spawn('agent-1', 'claude', ['--print']);
 *   mgr.sendKeys('agent-1', 'fix the bug\r');
 *   console.log(mgr.capture('agent-1', 40));
 */

import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { createWriteStream, mkdirSync, existsSync, readSync } from "node:fs";

// replaced by --define at build time
export const VERSION = "1.2.4";
import xterm from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

const { Terminal } = xterm;

export const SAFE_ENV_KEYS = ["PATH", "HOME", "USER", "TERM", "LANG", "SHELL",
  "NAMESPACE_ID", "AGENT_CHAIN_ROOT", "AGENT_CHAIN_CLI", "PTY_DAEMON",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "PTY_MGR_SESSION"];

const SESSION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function validateSessionName(name) {
  if (!name || typeof name !== "string") {
    throw new Error("session name is required");
  }
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(
      `invalid session name '${name}': must be alphanumeric, dots, hyphens, underscores (1-128 chars, start with alnum)`
    );
  }
}

class PtySession {
  constructor(name, opts = {}) {
    this.name = name;
    this.proc = null;
    this._pty = null; // Bun terminal object (for writing input)
    this.childPid = null;
    this.bridgePid = null;
    this.createdAt = new Date();
    this.cwd = opts.cwd || process.cwd();
    this.cmd = opts.cmd || "unknown";
    this.exitCode = null;
    this.exited = false;
    this.exitedAt = null;
    this._totalBytes = 0;

    this.events = new EventEmitter();


    // activity tracking (debounced, not per-write)
    this._lastActivityTime = Date.now();
    this._isIdle = false;
    this._activityTimer = null;
    this._activityDebounceMs = 500;
    this._idleThresholdMs = 5000;

    // logging
    this._logStream = null;
    this._logPath = null;
    this._logFormat = null;

    // headless terminal emulator -- this IS the screen buffer
    const cols = opts.cols || 200;
    const rows = opts.rows || 50;
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: opts.scrollback || 5000,
      allowProposedApi: true,
    });
    this._serializer = new SerializeAddon();
    this.terminal.loadAddon(this._serializer);

    // persistent decoder so split multi-byte UTF-8 sequences
    // don't produce U+FFFD replacement chars between data events
    this._decoder = new TextDecoder("utf-8");
  }

  /** attach a Bun subprocess with terminal. called by PtyManager.spawn() */
  _attach(proc) {
    this.proc = proc;
    this.childPid = proc.pid;
    this.bridgePid = proc.pid;
    this._pty = proc.terminal;

    proc.exited.then((code) => {
      if (this.exitCode === null) this.exitCode = code;
      this.exited = true;
      this.exitedAt = new Date();
      this.events.emit("exit", { exitCode: this.exitCode, signal: null });
    });
  }

  /** called by Bun terminal data callback */
  _onData(str) {
    this._totalBytes += str.length;
    this.terminal.write(str);

    // activity tracking: debounced, not per-write
    const now = Date.now();
    this._lastActivityTime = now;
    if (this._isIdle) {
      this._isIdle = false;
      this.events.emit("activity", { type: "active", at: now });
    }
    clearTimeout(this._activityTimer);
    this._activityTimer = setTimeout(() => {
      this._isIdle = true;
      this.events.emit("activity", { type: "idle", at: Date.now() });
    }, this._idleThresholdMs);

    this.events.emit("data", str);
  }

  /**
   * capture the rendered screen buffer.
   *
   * returns what you'd actually see on the terminal right now.
   * escape codes, cursor movements, line erases -- all resolved.
   * equivalent of reading the full terminal screen buffer.
   *
   * @param {number} [tailLines] - last N lines (0 or omit = visible screen)
   * @param {object} [opts] - options
   * @param {boolean} [opts.screen] - only capture visible rows (skip scrollback)
   * @returns {string}
   */
  capture(tailLines, opts = {}) {
    const buf = this.terminal.buffer.active;
    const lines = [];

    const startLine = opts.screen ? buf.baseY : 0;
    const totalLines = buf.baseY + this.terminal.rows;
    for (let i = startLine; i < totalLines; i++) {
      const line = buf.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }

    // trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }

    if (tailLines && tailLines > 0) {
      return lines.slice(-tailLines).join("\n");
    }
    return lines.join("\n");
  }

  /**
   * capture the rendered screen with ANSI color/attribute escape codes.
   * uses @xterm/addon-serialize to preserve colors, bold, etc.
   * @returns {string}
   */
  captureAnsi() {
    return this._serializer.serialize();
  }

  /**
   * capture visible content with ANSI colors, trimmed of empty lines.
   * reads cells individually to build colored output line by line.
   * result starts from line 0 (no leading empty rows).
   * @param {number} [tailLines] - last N lines (0 = all content)
   * @returns {string}
   */
  captureAnsiCompact(tailLines) {
    const buf = this.terminal.buffer.active;
    const totalLines = buf.baseY + this.terminal.rows;
    const lines = [];

    for (let y = 0; y < totalLines; y++) {
      const line = buf.getLine(y);
      if (!line) { lines.push(""); continue; }

      let out = "";
      let prevFg = -1, prevBg = -1, prevBold = false, prevDim = false;
      let prevItalic = false, prevUnder = false, prevInverse = false;

      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        if (!cell) continue;
        const ch = cell.getChars();
        if (!ch) continue;

        const fg = cell.getFgColor();
        const bg = cell.getBgColor();
        const bold = cell.isBold() !== 0;
        const dim = cell.isDim() !== 0;
        const italic = cell.isItalic() !== 0;
        const under = cell.isUnderline() !== 0;
        const inverse = cell.isInverse() !== 0;
        const fgMode = cell.getFgColorMode();
        const bgMode = cell.getBgColorMode();

        // emit SGR only when attributes change
        if (fg !== prevFg || bg !== prevBg || bold !== prevBold ||
            dim !== prevDim || italic !== prevItalic ||
            under !== prevUnder || inverse !== prevInverse) {
          const parts = ["0"]; // reset
          if (bold) parts.push("1");
          if (dim) parts.push("2");
          if (italic) parts.push("3");
          if (under) parts.push("4");
          if (inverse) parts.push("7");
          // foreground
          if (fgMode === 1) parts.push(fg < 8 ? `${30 + fg}` : `${90 + fg - 8}`);
          else if (fgMode === 2) parts.push(`38;5;${fg}`);
          else if (fgMode === 3) {
            const r = (fg >> 16) & 0xff, g = (fg >> 8) & 0xff, b = fg & 0xff;
            parts.push(`38;2;${r};${g};${b}`);
          }
          // background
          if (bgMode === 1) parts.push(bg < 8 ? `${40 + bg}` : `${100 + bg - 8}`);
          else if (bgMode === 2) parts.push(`48;5;${bg}`);
          else if (bgMode === 3) {
            const r = (bg >> 16) & 0xff, g = (bg >> 8) & 0xff, b = bg & 0xff;
            parts.push(`48;2;${r};${g};${b}`);
          }
          out += `\x1b[${parts.join(";")}m`;
          prevFg = fg; prevBg = bg; prevBold = bold; prevDim = dim;
          prevItalic = italic; prevUnder = under; prevInverse = inverse;
        }
        out += ch;
      }
      if (prevFg !== -1 || prevBold) out += "\x1b[0m";
      lines.push(out);
    }

    // trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].replace(/\x1b\[[^m]*m/g, "").trim() === "") {
      lines.pop();
    }
    // trim leading empty lines
    while (lines.length > 0 && lines[0].replace(/\x1b\[[^m]*m/g, "").trim() === "") {
      lines.shift();
    }

    if (tailLines && tailLines > 0) {
      return lines.slice(-tailLines).join("\r\n");
    }
    return lines.join("\r\n");
  }

  /**
   * resize the PTY and headless terminal.
   * @param {number} cols
   * @param {number} rows
   */
  resize(cols, rows) {
    cols = Math.max(20, Math.min(500, cols));
    rows = Math.max(5, Math.min(200, rows));
    this.terminal.resize(cols, rows);
    if (this._pty && !this.exited) {
      try { this._pty.resize(cols, rows); } catch {}
    }
  }

  write(text) {
    if (this.exited) {
      throw new Error(`session '${this.name}' has exited`);
    }
    // bracket paste mode: wrap multiline text so the shell treats it
    // as a single paste rather than executing each line on \n
    if (text.includes("\n")) {
      this._pty.write(`\x1b[200~${text}\x1b[201~`);
    } else {
      this._pty.write(text);
    }
  }

  kill(signal = "SIGTERM") {
    if (!this.exited) {
      try { this.proc.kill(signal); } catch {}
      try { this._pty?.close(); } catch {}
    }
  }

  dispose() {
    clearTimeout(this._activityTimer);
    this.kill();
    if (this._logStream) this.stopLog();
    try { this.terminal.dispose(); } catch {}
  }

  isAlive() {
    return !this.exited;
  }

  /**
   * start logging session output to a file.
   *
   * format:
   *   "raw"      - raw PTY bytes (escape codes included, replayable)
   *   "rendered"  - clean screen snapshots on each data event
   *   "jsonl"     - timestamped JSON lines { t, type, data }
   *
   * @param {string} logPath - file path to write to
   * @param {string} [format="raw"] - log format
   */
  startLog(logPath, format = "raw") {
    if (this._logStream) this.stopLog();

    // ensure parent dir exists
    mkdirSync(dirname(logPath), { recursive: true });

    this._logPath = logPath;
    this._logFormat = format;
    this._logStream = createWriteStream(logPath, { flags: "a" });

    // write header for jsonl
    if (format === "jsonl") {
      this._logStream.write(
        JSON.stringify({
          t: Date.now(),
          type: "start",
          name: this.name,
          cmd: this.cmd,
          cols: this.terminal.cols,
          rows: this.terminal.rows,
        }) + "\n"
      );
    }

    // hook into data events
    this._logHandler = (chunk) => {
      if (!this._logStream) return;
      switch (this._logFormat) {
        case "raw":
          this._logStream.write(chunk);
          break;
        case "rendered":
          this._logStream.write(
            `--- ${new Date().toISOString()} ---\n${this.capture()}\n\n`
          );
          break;
        case "jsonl":
          this._logStream.write(
            JSON.stringify({ t: Date.now(), type: "o", data: chunk }) + "\n"
          );
          break;
      }
    };
    this.events.on("data", this._logHandler);

    // log input too for jsonl (send-keys)
    if (format === "jsonl") {
      this._origWrite = this.write.bind(this);
      const session = this;
      this.write = function (text) {
        if (session._logStream) {
          session._logStream.write(
            JSON.stringify({ t: Date.now(), type: "i", data: text }) + "\n"
          );
        }
        session._origWrite(text);
      };
    }

    // log exit
    this._logExitHandler = ({ exitCode }) => {
      if (!this._logStream) return;
      if (this._logFormat === "jsonl") {
        this._logStream.write(
          JSON.stringify({ t: Date.now(), type: "exit", exitCode }) + "\n"
        );
      } else if (this._logFormat === "rendered") {
        this._logStream.write(
          `--- EXIT (code: ${exitCode}) ${new Date().toISOString()} ---\n`
        );
      }
      this.stopLog();
    };
    this.events.on("exit", this._logExitHandler);
  }

  stopLog() {
    if (this._logHandler) {
      this.events.off("data", this._logHandler);
      this._logHandler = null;
    }
    if (this._logExitHandler) {
      this.events.off("exit", this._logExitHandler);
      this._logExitHandler = null;
    }
    if (this._origWrite) {
      this.write = this._origWrite;
      this._origWrite = null;
    }
    if (this._logStream) {
      this._logStream.end();
      this._logStream = null;
    }
    const path = this._logPath;
    this._logPath = null;
    this._logFormat = null;
    return path;
  }

  info() {
    return {
      name: this.name,
      pid: this.childPid || this.bridgePid,
      bridgePid: this.bridgePid,
      childPid: this.childPid,
      cmd: this.cmd,
      cwd: this.cwd,
      alive: this.isAlive(),
      exitCode: this.exitCode,
      createdAt: this.createdAt.toISOString(),
      exitedAt: this.exitedAt ? this.exitedAt.toISOString() : null,
      terminalSize: `${this.terminal.cols}x${this.terminal.rows}`,
      outputBytes: this._totalBytes,
      logging: this._logPath ? { path: this._logPath, format: this._logFormat } : null,
    };
  }
}

export class PtyManager {
  constructor() {
    /** @type {Map<string, PtySession>} */
    this.sessions = new Map();
  }

  /**
   * spawn a command inside a real PTY with terminal emulation
   *
   * @param {string} name - unique session name
   * @param {string} cmd - command to run
   * @param {string[]} [args] - arguments
   * @param {object} [opts]
   * @param {string} [opts.cwd] - working directory
   * @param {object} [opts.env] - extra env vars
   * @param {number} [opts.cols] - terminal columns (default 200)
   * @param {number} [opts.rows] - terminal rows (default 50)
   * @param {number} [opts.scrollback] - scrollback lines (default 5000)
   * @returns {string} session name
   */
  spawn(name, cmd, args = [], opts = {}) {
    validateSessionName(name);
    if (this.sessions.has(name)) {
      throw new Error(`session '${name}' already exists`);
    }

    const cols = opts.cols || 100;
    const rows = opts.rows || 35;

    const session = new PtySession(name, {
      cwd: opts.cwd || process.cwd(),
      cmd: [cmd, ...args].join(" "),
      cols,
      rows,
      scrollback: opts.scrollback,
    });

    const proc = Bun.spawn([cmd, ...args], {
      cwd: opts.cwd || process.cwd(),
      env: { TERM: "xterm-256color", ...process.env, ...opts.env },
      terminal: {
        cols,
        rows,
        data(_terminal, data) {
          session._onData(session._decoder.decode(data, { stream: true }));
        },
      },
    });

    session._attach(proc);
    this.sessions.set(name, session);
    return name;
  }

  get(name) {
    const s = this.sessions.get(name);
    if (!s) throw new Error(`session '${name}' not found`);
    return s;
  }

  /** send keystrokes. use \r for Enter, \x03 for Ctrl-C */
  sendKeys(name, text) {
    this.get(name).write(text);
  }

  /**
   * capture rendered screen.
   * returns clean text with all escape codes resolved.
   */
  capture(name, tailLines, opts = {}) {
    return this.get(name).capture(tailLines, opts);
  }

  /** check if child process is alive */
  isAlive(name) {
    return this.get(name).isAlive();
  }

  /** get child process pid */
  pid(name) {
    const s = this.get(name);
    return s.childPid || s.bridgePid;
  }

  /** kill session process (session stays in registry for inspection) */
  kill(name) {
    this.get(name).kill();
  }

  /** rename a session */
  rename(oldName, newName) {
    validateSessionName(newName);
    const s = this.sessions.get(oldName);
    if (!s) throw new Error(`session '${oldName}' not found`);
    if (this.sessions.has(newName)) {
      throw new Error(`session '${newName}' already exists`);
    }
    s.name = newName;
    this.sessions.delete(oldName);
    this.sessions.set(newName, s);
  }

  /** kill + remove session from registry */
  remove(name) {
    const s = this.sessions.get(name);
    if (s) {
      s.dispose();
      this.sessions.delete(name);
    }
  }

  /** check if session exists */
  has(name) {
    return this.sessions.has(name);
  }

  /** list sessions */
  list(filter = {}) {
    const results = [];
    for (const s of this.sessions.values()) {
      if (filter.alive !== undefined && s.isAlive() !== filter.alive) continue;
      results.push(s.info());
    }
    return results;
  }

  /** wait for rendered screen to contain a matching line */
  waitFor(name, pattern, timeoutMs = 30000) {
    const session = this.get(name);
    const re = typeof pattern === "string" ? new RegExp(pattern) : pattern;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.events.off("data", onData);
        reject(new Error(`timeout waiting for: ${pattern}`));
      }, timeoutMs);

      // check current screen
      for (const line of session.capture().split("\n")) {
        if (re.test(line)) {
          clearTimeout(timeout);
          resolve(line);
          return;
        }
      }

      // poll on new data (re-read screen each time)
      function onData() {
        for (const line of session.capture().split("\n")) {
          if (re.test(line)) {
            clearTimeout(timeout);
            session.events.off("data", onData);
            resolve(line);
            return;
          }
        }
      }
      session.events.on("data", onData);
    });
  }

  /** wait for session to exit */
  waitForExit(name, timeoutMs = 60000) {
    const session = this.get(name);
    if (session.exited) {
      return Promise.resolve({ exitCode: session.exitCode, signal: null });
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.events.off("exit", onExit);
        reject(new Error("timeout waiting for exit"));
      }, timeoutMs);

      function onExit({ exitCode, signal }) {
        clearTimeout(timeout);
        resolve({ exitCode, signal });
      }
      session.events.on("exit", onExit);
    });
  }

  /** kill and remove all sessions */
  destroyAll() {
    for (const [name] of this.sessions) {
      this.remove(name);
    }
  }
}

// ─── CLI daemon (unix socket for persistent sessions) ────────────────

import { createServer, createConnection } from "node:net";
import { unlinkSync, chmodSync } from "node:fs";
import { tmpdir, homedir } from "node:os";

// daemon name from @name, --daemon flag, or PTY_DAEMON env var
function getDaemonName() {
  const at = process.argv.find((a) => a.startsWith("@"));
  if (at) return at.slice(1);
  const idx = process.argv.indexOf("--daemon");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env.PTY_DAEMON || "default";
}

function socketPath(name) {
  // use ~/.pty-manager/ instead of /tmp to avoid world-writable dir
  const dir = join(homedir(), ".pty-manager");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${name}.sock`);
}

const DAEMON_NAME = getDaemonName();
const SOCKET_PATH = socketPath(DAEMON_NAME);

/**
 * daemon: long-running process that holds all sessions.
 * clients connect via unix socket, send JSON commands, get JSON responses.
 */
function startDaemon() {
  if (existsSync(SOCKET_PATH)) {
    // check if another daemon is running
    try {
      const probe = createConnection(SOCKET_PATH);
      probe.on("connect", () => {
        probe.end();
        if (process.send) {
          process.send({ ready: true });
        } else {
          console.log("daemon already running at", SOCKET_PATH);
        }
        process.exit(0);
      });
      probe.on("error", () => {
        // stale socket, remove and continue
        unlinkSync(SOCKET_PATH);
        listen();
      });
      return;
    } catch {
      unlinkSync(SOCKET_PATH);
    }
  }
  listen();

  function listen() {
    const mgr = new PtyManager();
    const daemonStartedAt = new Date();
    // daemon-level config
    const config = {
      cols: 100,
      rows: 50,
      capOnSend: false,
      sendDelay: 1000,
    };

    const MAX_BUF = 1024 * 1024; // 1MB max request buffer

    const server = createServer((conn) => {
      let buf = "";
      let attached = false; // true when in attach streaming mode

      // suppress connection errors (client disconnect, etc.)
      conn.on("error", () => {});

      // timeout: close idle connections after 30s (non-attach)
      conn.setTimeout(30000, () => {
        if (!attached) conn.destroy();
      });

      conn.on("data", async (data) => {
        // in attach mode, forward raw input to the pty
        if (attached) {
          attached.write(data.toString());
          return;
        }

        buf += data.toString();
        if (buf.length > MAX_BUF) {
          conn.write(JSON.stringify({ ok: false, error: "request too large" }) + "\n");
          conn.destroy();
          return;
        }
        // process newline-delimited JSON
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const req = JSON.parse(line);

            // attach is special: switches to streaming mode
            if (req.cmd === "attach") {
              const session = mgr.get(req.name);
              const cols = session.terminal.cols;
              const rows = session.terminal.rows;
              // send initial ack with terminal size
              conn.write(JSON.stringify({ ok: true, mode: "attach", cols, rows }) + "\n");

              // send current buffer as plain text, then SIGWINCH for colored redraw
              conn.write("\x1b[2J\x1b[H");
              const screen = session.capture(session.terminal.rows);
              if (screen) conn.write(screen.replace(/\n/g, "\r\n") + "\r\n");

              // force TUI apps to redraw on top
              if (session.childPid) {
                try { process.kill(session.childPid, "SIGWINCH"); } catch {}
              }

              // stream new pty output to client
              const onData = (chunk) => {
                try { conn.write(chunk); } catch {}
              };
              session.events.on("data", onData);

              // when session exits, notify and close
              const onExit = () => {
                try {
                  conn.write("\r\n[session exited]\r\n");
                  conn.end();
                } catch {}
              };
              session.events.on("exit", onExit);

              // forward client input to pty
              attached = session;

              // cleanup on disconnect
              conn.on("close", () => {
                session.events.off("data", onData);
                session.events.off("exit", onExit);
                attached = false;
              });
              return;
            }

            // tg-wait holds the connection open - disable the idle timeout
            if (req.cmd === "tg-wait") conn.setTimeout(0);
            const res = await handleCommand(mgr, req, daemonStartedAt, config, tgState);
            conn.write(JSON.stringify(res) + "\n");
          } catch (err) {
            conn.write(
              JSON.stringify({ ok: false, error: err.message }) + "\n"
            );
          }
        }
      });
    });

    server.listen(SOCKET_PATH, () => {
      // restrict socket to owner only (fixes world-writable /tmp vuln)
      try { chmodSync(SOCKET_PATH, 0o600); } catch {}

      // signal parent process that we're ready
      if (process.send) {
        process.send({ ready: true });
      } else {
        console.log(`pty-manager daemon (${DAEMON_NAME}) listening at`, SOCKET_PATH);
        console.log("pid:", process.pid);
      }
    });

    // telegram state (shared between poller and handleCommand)
    const tgState = { waiter: null, lastUpdateId: 0, active: false, lastSession: null };

    async function tgSend(chatId, text) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      // telegram max message length is 4096
      const chunks = [];
      for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
      for (const chunk of chunks) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: chunk }),
        });
      }
    }

    async function tgHandleCommand(chatId, text) {
      const parts = text.trim().split(/\s+/);
      const cmd = parts[0].replace(/^\//, "").toLowerCase().split("@")[0];
      const args = parts.slice(1);
      switch (cmd) {
        case "start":
        case "help":
          await tgSend(chatId, [
            "pty-mgr bot - commands:",
            "/list           list sessions",
            "/capture <name> [lines]  capture output",
            "/send <name> <text>      send text",
            "/kill <name>    kill session",
            "/spawn <name> [cmd]      spawn session",
            "/status         daemon info",
          ].join("\n"));
          break;
        case "list":
        case "ls": {
          const sessions = mgr.list();
          if (!sessions.length) { await tgSend(chatId, "no sessions"); break; }
          const lines = sessions.map(s => `${s.name}  ${s.alive ? "alive" : "dead"}  ${s.cmd}`).join("\n");
          await tgSend(chatId, lines);
          break;
        }
        case "capture":
        case "cap":
        case "c": {
          const capName = args[0] && mgr.has(args[0]) ? args[0] : tgState.lastSession;
          const linesArg = args[0] && mgr.has(args[0]) ? args[1] : args[0];
          const lines = linesArg ? parseInt(linesArg, 10) : 50;
          if (!capName) { await tgSend(chatId, "usage: /capture <name> [lines]"); break; }
          if (!mgr.has(capName)) { await tgSend(chatId, `not found: ${capName}`); break; }
          tgState.lastSession = capName;
          const output = mgr.capture(capName, lines);
          await tgSend(chatId, output || "(empty)");
          break;
        }
        case "send":
        case "s": {
          let name, sendText;
          if (args[0] && mgr.has(args[0])) {
            name = args[0];
            sendText = args.slice(1).join(" ");
          } else if (tgState.lastSession) {
            name = tgState.lastSession;
            sendText = args.join(" ");
          }
          if (!name || !sendText) { await tgSend(chatId, `usage: /send [name] <text>${tgState.lastSession ? `\nlast: ${tgState.lastSession}` : ""}`); break; }
          if (!mgr.has(name)) { await tgSend(chatId, `not found: ${name}`); break; }
          tgState.lastSession = name;
          mgr.sendKeys(name, sendText);
          await new Promise(r => setTimeout(r, 1000));
          mgr.sendKeys(name, "\r");
          await tgSend(chatId, `sent to ${name}`);
          // auto-capture on idle - wait for session output to settle
          { const session = mgr.get(name);
            const cap = await new Promise(resolve => {
              const timeout = setTimeout(() => {
                session.events.off("activity", onIdle);
                resolve(mgr.capture(name, 30));
              }, 60000);
              const onIdle = (ev) => {
                if (ev.type === "idle") {
                  session.events.off("activity", onIdle);
                  clearTimeout(timeout);
                  resolve(mgr.capture(name, 30));
                }
              };
              session.events.on("activity", onIdle);
            });
            if (cap) await tgSend(chatId, cap);
          }
          break;
        }
        case "kill":
        case "k": {
          const name = args[0] || tgState.lastSession;
          if (!name) { await tgSend(chatId, "usage: /kill <name>"); break; }
          if (!mgr.has(name)) { await tgSend(chatId, `not found: ${name}`); break; }
          if (tgState.lastSession === name) tgState.lastSession = null;
          mgr.kill(name);
          await tgSend(chatId, `killed: ${name}`);
          break;
        }
        case "spawn":
        case "n": {
          const name = args[0];
          const spawnCmd = args[1] || "zsh";
          const spawnArgs = args.slice(2);
          if (!name) { await tgSend(chatId, "usage: /spawn <name> [cmd]"); break; }
          const env = buildSafeEnv();
          env.PTY_MGR_SESSION = name;
          mgr.spawn(name, spawnCmd, spawnArgs, { env });
          await tgSend(chatId, `spawned: ${name}  pid=${mgr.pid(name)}`);
          break;
        }
        case "status": {
          const sessions = mgr.list();
          const alive = sessions.filter(s => s.alive).length;
          await tgSend(chatId, `sessions: ${sessions.length} (${alive} alive)`);
          break;
        }
        default:
          await tgSend(chatId, `unknown: ${cmd}\nuse /help`);
      }
    }

    async function tgPoller() {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) return;
      tgState.active = true;
      while (tgState.active) {
        let error = false;
        try {
          const url = `https://api.telegram.org/bot${token}/getUpdates`
            + `?timeout=25&offset=${tgState.lastUpdateId + 1}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
          const data = await res.json();
          for (const update of data.result || []) {
            tgState.lastUpdateId = update.update_id;
            const text = update.message?.text;
            const msgChatId = update.message?.chat?.id;
            const userId = String(update.message?.from?.id);
            const chatId = String(msgChatId);
            const knownId = process.env.TELEGRAM_CHAT_ID;
            const match = chatId === knownId || userId === knownId;
            if (!text || !match) continue;
            // commands always get handled directly
            if (text.startsWith("/")) {
              tgHandleCommand(msgChatId, text).catch(() => {});
              continue;
            }
            // plain text: resolve waiter if pending, otherwise send to last session
            if (tgState.waiter) {
              const w = tgState.waiter;
              tgState.waiter = null;
              clearTimeout(w.timer);
              w.resolve(text);
            } else if (tgState.lastSession && mgr.has(tgState.lastSession)) {
              const sn = tgState.lastSession;
              mgr.sendKeys(sn, text);
              await new Promise(r => setTimeout(r, 1000));
              mgr.sendKeys(sn, "\r");
              await tgSend(msgChatId, `sent to ${sn}`);
              // auto-capture after send
              await new Promise(r => setTimeout(r, 6000));
              const cap = mgr.capture(sn, 30);
              if (cap) await tgSend(msgChatId, cap);
            }
          }
        } catch { error = true; }
        if (error) await new Promise(r => setTimeout(r, 5000));
      }
    }

    if (process.env.TELEGRAM_BOT_TOKEN) tgPoller();

    // cleanup on exit
    const cleanup = () => {
      tgState.active = false;
      mgr.destroyAll();
      try { unlinkSync(SOCKET_PATH); } catch {}
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }
}

/**
 * match session names against a pattern.
 * supports: "all", "name*" (prefix glob), exact name.
 */
function matchSessions(mgr, pattern) {
  if (pattern === "all") {
    return mgr.list().map((s) => s.name);
  }
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return mgr.list()
      .filter((s) => s.name.startsWith(prefix))
      .map((s) => s.name);
  }
  // exact match
  if (mgr.has(pattern)) return [pattern];
  return [];
}

export function buildSafeEnv(extra) {
  const safeEnv = {};
  for (const k of SAFE_ENV_KEYS) {
    if (process.env[k]) safeEnv[k] = process.env[k];
    if (extra?.[k]) safeEnv[k] = extra[k];
  }
  return safeEnv;
}

async function handleCommand(mgr, req, daemonStartedAt, config, tgState = {}) {
  const { cmd, name, args } = req;

  switch (cmd) {
    case "status": {
      const sessions = mgr.list();
      const alive = sessions.filter((s) => s.alive).length;
      const dead = sessions.length - alive;
      const uptimeMs = Date.now() - daemonStartedAt.getTime();
      return {
        ok: true,
        status: {
          name: DAEMON_NAME,
          pid: process.pid,
          socket: SOCKET_PATH,
          startedAt: daemonStartedAt.toISOString(),
          uptimeMs,
          uptime: formatUptime(uptimeMs),
          sessions: { total: sessions.length, alive, dead },
          config: { ...config },
        },
      };
    }
    case "config": {
      const key = args?.key;
      const value = args?.value;
      if (!key) {
        return { ok: true, config: { ...config } };
      }
      switch (key) {
        case "screen": {
          const match = value?.match(/^(\d+)x(\d+)$/);
          if (!match) return { ok: false, error: "format: <cols>x<rows> (e.g. 100x50)" };
          config.cols = parseInt(match[1], 10);
          config.rows = parseInt(match[2], 10);
          return { ok: true, config: { cols: config.cols, rows: config.rows } };
        }
        case "cap-on-send": {
          if (value === "on") config.capOnSend = true;
          else if (value === "off") config.capOnSend = false;
          else return { ok: false, error: "value must be 'on' or 'off'" };
          return { ok: true, config: { capOnSend: config.capOnSend } };
        }
        case "send-delay": {
          const ms = parseInt(value, 10);
          if (isNaN(ms) || ms < 0) return { ok: false, error: "value must be milliseconds (e.g. 1000)" };
          config.sendDelay = ms;
          return { ok: true, config: { sendDelay: config.sendDelay } };
        }
        default:
          return { ok: false, error: `unknown config key: ${key}. valid: screen, cap-on-send, send-delay` };
      }
    }
    case "spawn": {
      const cmdToRun = args?.cmd || "zsh";
      const cmdArgs = args?.args || [];
      // clamp terminal size to prevent memory exhaustion
      const cols = Math.max(20, Math.min(500, args?.cols || config.cols));
      const rows = Math.max(5, Math.min(200, args?.rows || config.rows));
      const safeEnv = buildSafeEnv(args?.env);
      safeEnv.PTY_MGR_SESSION = name;
      const opts = {
        cwd: args?.cwd,
        env: safeEnv,
        cols,
        rows,
      };
      mgr.spawn(name, cmdToRun, cmdArgs, opts);
      const res = { ok: true, name, pid: mgr.pid(name) };
      // auto-start logging if --log flag
      if (args?.log) {
        const logDir = join(process.cwd(), "agents", "logs");
        const logPath = join(logDir, `${name}-${Date.now()}.jsonl`);
        mgr.get(name).startLog(logPath, "jsonl");
        res.logPath = logPath;
      }
      return res;
    }
    case "wrap": {
      // client must send cwd -- daemon's cwd is not the user's cwd
      const clientCwd = args?.cwd || process.cwd();
      const rawBase = args?.base || clientCwd.split("/").pop() || "session";
      // sanitize base name for session naming (must start with alnum)
      const baseName = rawBase.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^[\._-]+/, "") || "session";
      const cmdToRun = args?.cmd || "zsh";
      const cmdArgs = args?.args || [];

      // always use numeric suffix: baseName-1, baseName-2, ...
      let maxNum = 0;
      for (const s of mgr.sessions.keys()) {
        if (!s.startsWith(`${baseName}-`)) continue;
        const suffix = s.slice(baseName.length + 1);
        const num = parseInt(suffix, 10);
        if (!isNaN(num) && num >= maxNum) maxNum = num + 1;
      }
      if (maxNum === 0) maxNum = 1;
      const nextName = `${baseName}-${maxNum}`;

      const cols = Math.max(20, Math.min(500, args?.cols || config.cols));
      const rows = Math.max(5, Math.min(200, args?.rows || config.rows));

      // wrap spawns through user's login shell so shell functions/aliases work
      // (like tmux does). this means glm, nvm, conda, etc. all resolve.
      const userShell = process.env.SHELL || "/bin/zsh";
      let shellCmd, shellArgs;
      if (cmdToRun === "zsh" && cmdArgs.length === 0) {
        // bare wrap: just open a login shell
        shellCmd = userShell;
        shellArgs = ["-l"];
      } else {
        // wrap <cmd> [args]: run through login interactive shell
        const escaped = [cmdToRun, ...cmdArgs].map(a => a.includes(" ") ? `"${a}"` : a).join(" ");
        shellCmd = userShell;
        shellArgs = ["-lic", escaped];
      }

      // pass full env for wrap (user expects their shell env, not a sandbox)
      const wrapEnv = { ...process.env, ...(args?.env || {}) };

      mgr.spawn(nextName, shellCmd, shellArgs, { cwd: clientCwd, env: wrapEnv, cols, rows });
      const res = { ok: true, name: nextName, pid: mgr.pid(nextName) };

      if (args?.log) {
        const logDir = join(clientCwd, "agents", "logs");
        const logPath = join(logDir, `${nextName}-${Date.now()}.jsonl`);
        mgr.get(nextName).startLog(logPath, "jsonl");
        res.logPath = logPath;
      }
      return res;
    }
    case "send": {
      const text = args?.text || "";
      const enter = args?.enter || false;
      const raw = args?.raw || false;

      if (raw || !enter) {
        // raw mode or no enter: send as-is
        mgr.sendKeys(name, text);
      } else {
        mgr.sendKeys(name, text);
        await new Promise((r) => setTimeout(r, config.sendDelay));
        mgr.sendKeys(name, "\r");
      }

      if (config.capOnSend) {
        await new Promise((r) => setTimeout(r, 1000));
        return { ok: true, output: mgr.capture(name, args?.capLines || 20) };
      }
      return { ok: true };
    }
    case "capture": {
      const capOpts = args?.screen ? { screen: true } : {};
      // "all" or glob pattern
      if (name === "all" || (name && name.endsWith("*"))) {
        const names = matchSessions(mgr, name);
        const results = {};
        for (const n of names) {
          results[n] = mgr.capture(n, args?.lines, capOpts);
        }
        return { ok: true, results };
      }
      const output = mgr.capture(name, args?.lines, capOpts);
      return { ok: true, output };
    }
    case "resize": {
      const cols = args?.cols;
      const rows = args?.rows;
      if (!cols || !rows) {
        return { ok: false, error: "resize requires cols and rows" };
      }
      const session = mgr.get(name);
      session.resize(cols, rows);
      return { ok: true, cols: session.terminal.cols, rows: session.terminal.rows };
    }
    case "kill": {
      const names = matchSessions(mgr, name);
      if (names.length === 0) {
        return { ok: false, error: `no sessions matching: ${name}` };
      }
      for (const n of names) mgr.kill(n);
      return { ok: true, killed: names };
    }
    case "remove": {
      const names = matchSessions(mgr, name);
      if (names.length === 0) {
        return { ok: false, error: `no sessions matching: ${name}` };
      }
      for (const n of names) mgr.remove(n);
      return { ok: true, removed: names };
    }
    case "alive": {
      return { ok: true, alive: mgr.isAlive(name) };
    }
    case "has": {
      return { ok: true, exists: mgr.has(name) };
    }
    case "list": {
      return { ok: true, sessions: mgr.list(args || {}) };
    }
    case "info": {
      return { ok: true, info: mgr.get(name).info() };
    }
    case "pid": {
      return { ok: true, pid: mgr.pid(name) };
    }
    case "rename": {
      const newName = args?.newName;
      if (!newName) return { ok: false, error: "newName is required" };
      mgr.rename(name, newName);
      return { ok: true, oldName: name, newName };
    }
    case "log": {
      const session = mgr.get(name);
      const action = args?.action || "on";
      if (action === "off" || action === "stop") {
        const path = session.stopLog();
        return { ok: true, stopped: true, path };
      }
      // default log dir: ./agents/logs/
      const format = args?.format || "jsonl";
      const ext = format === "jsonl" ? "jsonl" : format === "rendered" ? "log" : "raw";
      const logDir = args?.dir || join(process.cwd(), "agents", "logs");
      const ts = Date.now();
      const logPath = args?.path || join(logDir, `${name}-${ts}.${ext}`);
      session.startLog(logPath, format);
      return { ok: true, path: logPath, format };
    }
    case "shutdown": {
      mgr.destroyAll();
      // close server and exit after response is sent
      setTimeout(() => {
        try { unlinkSync(SOCKET_PATH); } catch {}
        process.exit(0);
      }, 50);
      return { ok: true, stopped: DAEMON_NAME, pid: process.pid };
    }
    case "tg-send": {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!token || !chatId) return { ok: false, error: "NO_TOKEN: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" };
      const msg = req.args?.message;
      if (!msg) return { ok: false, error: "message required" };
      if (req.args?.session) tgState.lastSession = req.args.session;
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: msg }),
      });
      return { ok: true };
    }
    case "tg-wait": {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!token || !chatId) return { ok: false, error: "NO_TOKEN: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" };
      if (tgState.waiter) return { ok: false, error: "ALREADY_WAITING" };
      const msg = req.args?.message;
      const timeoutMs = req.args?.timeout ?? 60000;
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: msg }),
      });
      const sessionName = req.args?.session;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          tgState.waiter = null;
          resolve({ ok: false, error: "TIMEOUT" });
        }, timeoutMs);
        tgState.waiter = {
          resolve: (text) => {
            if (sessionName && mgr.has(sessionName)) {
              mgr.sendKeys(sessionName, text);
              setTimeout(() => mgr.sendKeys(sessionName, "\r"), 1000);
            }
            resolve({ ok: true, reply: text });
          },
          timer,
        };
      });
    }
    default:
      return { ok: false, error: `unknown command: ${cmd}` };
  }
}

/**
 * client: send a single command to the daemon, print result.
 */
function sendCommandTo(sock, req) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(sock);
    conn.on("error", (err) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        reject(new Error("daemon not running"));
      } else {
        reject(err);
      }
    });
    conn.on("connect", () => {
      conn.write(JSON.stringify(req) + "\n");
    });
    let buf = "";
    conn.on("data", (data) => {
      buf += data.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        const res = JSON.parse(buf.slice(0, nl));
        conn.end();
        resolve(res);
      }
    });
  });
}

function sendCommand(req) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(SOCKET_PATH);
    conn.on("error", (err) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        reject(new Error("daemon not running. start with: pty-mgr daemon"));
      } else {
        reject(err);
      }
    });
    conn.on("connect", () => {
      conn.write(JSON.stringify(req) + "\n");
    });
    let buf = "";
    conn.on("data", (data) => {
      buf += data.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        const res = JSON.parse(buf.slice(0, nl));
        conn.end();
        resolve(res);
      }
    });
  });
}

/**
 * attach: interactive streaming connection to a session.
 * puts terminal in raw mode, forwards keystrokes, streams output.
 * ctrl-] to detach.
 */
function attachToSession(name) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(SOCKET_PATH);

    conn.on("error", (err) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        reject(new Error("daemon not running. start with: pty-mgr daemon"));
      } else {
        reject(err);
      }
    });

    conn.on("connect", () => {
      // send attach request
      conn.write(JSON.stringify({ cmd: "attach", name }) + "\n");

      let gotAck = false;
      let headerBuf = "";

      conn.on("data", (data) => {
        if (!gotAck) {
          // first line is the JSON ack
          headerBuf += data.toString();
          const nl = headerBuf.indexOf("\n");
          if (nl === -1) return;

          const ackStr = headerBuf.slice(0, nl);
          const remainder = headerBuf.slice(nl + 1);

          let ack;
          try {
            ack = JSON.parse(ackStr);
            if (!ack.ok) {
              console.error("error:", ack.error);
              conn.end();
              reject(new Error(ack.error));
              return;
            }
          } catch {
            console.error("bad ack from daemon");
            conn.end();
            reject(new Error("bad ack"));
            return;
          }

          gotAck = true;

          // resize client terminal to match session
          if (ack.cols && ack.rows) {
            // CSI 8 ; rows ; cols t  = resize terminal window
            process.stdout.write(`\x1b[8;${ack.rows};${ack.cols}t`);
          }

          // put terminal in raw mode
          process.stdin.setRawMode(true);
          process.stdin.resume();

          console.log(`attached to '${name}' (ctrl-] to detach)\r`);

          // write any remaining data after the ack
          if (remainder) {
            process.stdout.write(remainder);
          }

          // forward keystrokes to daemon -> pty
          process.stdin.on("data", (key) => {
            // ctrl-] (0x1d) = detach
            if (key.length === 1 && key[0] === 0x1d) {
              detach();
              return;
            }
            conn.write(key);
          });

          return;
        }

        // streaming mode: write pty output to terminal
        process.stdout.write(data);
      });

      conn.on("close", () => {
        detach();
      });

      let detached = false;
      function detach() {
        if (detached) return;
        detached = true;
        if (process.stdin.isRaw) {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeAllListeners("data");
        }
        conn.end();
        console.log("\r\ndetached");
        resolve();
      }
    });
  });
}

// ─── CLI entry point ─────────────────────────────────────────────────

const USAGE = `pty-mgr - PTY session manager

usage:
  p daemon                           start daemon (background: &)
  p daemon @myproject                named daemon (isolated sessions)
  p status                           daemon info + config
  p config                           show current config
  p config screen 100x50             set default terminal size
  p config cap-on-send on|off        return capture with every send
  p config send-delay <ms>           delay before enter (default 1000)
  p spawn <name> [cmd] [args...]     create session
  p wrap [cmd] [args...]             spawn with auto-incrementing cwd name
  p attach <name>                    interactive mode (ctrl-] detach)
  p send <name> <text>               send text + enter
  p send <name> --raw <text>         send text as-is (no enter)
  p capture <name> [lines]           capture screen output
  p capture all [lines]              capture from all sessions
  p capture <glob*> [lines]          capture matching sessions
  p watch <name> [interval]          compare two bottom-100 captures
  p list                             list all sessions
  p alive <name>                     check if alive
  p info <name>                      session details
  p kill <name>                      kill session
  p kill all                         kill all sessions
  p kill <glob*>                     kill matching sessions
  p rename <old> <new>                rename a session
  p remove <name|all|glob*>          kill + remove
  p log <name> on [jsonl|raw|rendered] start logging
  p log <name> off                    stop logging
  p spawn <name> --log [cmd]         spawn with logging (jsonl)
  p stop                             stop current daemon
  p stop all                         stop all daemons
  p setup                            wrap CLI tools (claude, etc.)
  p demo                             run self-test (no daemon needed)
  p tg <message>                     send telegram notification
  p tg <message> --reply             send message and wait for reply (blocking)
  p tg <message> --reply --timeout N wait N seconds for reply (default: 60)

shortcuts:
  n|new = spawn    w|wrap = wrap  s = send       c|cap = capture
  st = status      a = attach     k = kill
  l|ls = list      i = info       r|rm = remove
  mv|ren = rename
  d = daemon       cfg = config   x = stop

examples:
  p daemon &
  p @myproject daemon &
  p @myproject spawn agent-1 claude
  p spawn my-agent claude --print
  p wrap                            # spawns: pty-mgr-1
  p wrap                            # spawns: pty-mgr-2
  p wrap claude                     # spawns: pty-mgr-1 running claude
  p attach my-agent
  p send my-agent "fix the login bug"
  p capture my-agent 20
  p capture all 50
  p kill refa*
  p config screen 120x40`;

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runDemo() {
  const mgr = new PtyManager();

  console.log("--- pty-manager demo (xterm-headless) ---\n");

  console.log("1. spawn 'test-shell' (zsh in pty + xterm emulation)");
  mgr.spawn("test-shell", "zsh", [], { cols: 120, rows: 30 });
  await sleep(1000);

  console.log("2. sendKeys: echo hello-from-pty");
  mgr.sendKeys("test-shell", "echo hello-from-pty\r");
  await sleep(600);

  console.log("3. capture (last 5 lines):");
  console.log("  ---");
  for (const l of mgr.capture("test-shell", 5).split("\n")) {
    console.log("  | " + l);
  }
  console.log("  ---\n");

  console.log("4. sendKeys: ls | head -3");
  mgr.sendKeys("test-shell", "ls | head -3\r");
  await sleep(800);

  console.log("5. capture (last 8 lines):");
  console.log("  ---");
  for (const l of mgr.capture("test-shell", 8).split("\n")) {
    console.log("  | " + l);
  }
  console.log("  ---\n");

  console.log("6. alive:", mgr.isAlive("test-shell"));
  console.log("   pid:", mgr.pid("test-shell"));

  console.log("\n7. sessions:");
  for (const s of mgr.list()) {
    console.log(
      `   ${s.name}  pid=${s.pid}  ${s.terminalSize}  alive=${s.alive}`
    );
  }

  console.log("\n8. waitFor: echo MARKER_42");
  mgr.sendKeys("test-shell", "echo MARKER_42\r");
  const match = await mgr.waitFor("test-shell", /MARKER_42/, 5000);
  console.log("   matched:", match.trim());

  console.log("\n9. tty check:");
  mgr.sendKeys(
    "test-shell",
    'python3 -c "import sys; print(\'isatty:\', sys.stdout.isatty())"\r'
  );
  await sleep(800);
  const ttyLine = mgr
    .capture("test-shell", 5)
    .split("\n")
    .find((l) => l.includes("isatty:"));
  console.log("   " + (ttyLine || "(not found)").trim());

  console.log("\n10. kill");
  mgr.kill("test-shell");
  await mgr.waitForExit("test-shell", 5000).catch(() => {});
  console.log("    alive:", mgr.isAlive("test-shell"));

  console.log("\n11. post-mortem (last 3 lines):");
  for (const l of mgr.capture("test-shell", 3).split("\n")) {
    console.log("    | " + l);
  }

  mgr.destroyAll();
  console.log("\n--- demo complete ---");
}

function ask(question) {
  process.stdout.write(question);
  const byte = Buffer.alloc(1);
  let line = "";
  while (true) {
    const n = readSync(0, byte, 0, 1);
    if (n === 0) break;
    const ch = byte.toString("utf-8");
    if (ch === "\n") break;
    line += ch;
  }
  return line.trim();
}

function wrapperFunction(cmd) {
  return `
# pty-mgr: managed ${cmd} sessions
${cmd}() {
  command -v pty-mgr >/dev/null 2>&1 || command -v p >/dev/null 2>&1 || { command ${cmd} "$@"; return; }
  local _p
  _p=$(command -v p 2>/dev/null || command -v pty-mgr 2>/dev/null)
  $_p status >/dev/null 2>&1 || $_p daemon
  local _wrap_out _wrap_status _name
  _wrap_out=$($_p wrap command ${cmd} "$@" 2>&1)
  _wrap_status=$?
  if [ $_wrap_status -ne 0 ]; then
    echo "pty-mgr: wrap failed for ${cmd}" >&2
    case "$_wrap_out" in
      *"unknown command: wrap"*) echo "pty-mgr: daemon does not support wrap; restart it after saving active sessions" >&2 ;;
    esac
    [ -n "$_wrap_out" ] && printf '%s\\n' "$_wrap_out" >&2
    return $_wrap_status
  fi
  _name=$(printf '%s\\n' "$_wrap_out" | awk '$2 ~ /^pid=[0-9]+$/ { print $1; exit }')
  if [ -z "$_name" ]; then
    echo "pty-mgr: wrap failed for ${cmd}: unexpected output" >&2
    [ -n "$_wrap_out" ] && printf '%s\\n' "$_wrap_out" >&2
    return 1
  fi
  $_p attach "$_name"
}`;
}

function parseWatchIntervalMs(value = "4s") {
  const raw = String(value || "4s").trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s)?$/);
  if (!match) throw new Error("watch interval must be milliseconds or seconds, e.g. 4000ms or 4s");
  const amount = Number(match[1]);
  const unit = match[2] || "ms";
  const ms = unit === "s" ? amount * 1000 : amount;
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error("watch interval must be a non-negative duration");
  }
  return Math.round(ms);
}

function hashText(value) {
  return createHash("sha256").update(value || "").digest("hex");
}

function capturePayloadText(res) {
  if (res.results) {
    return Object.entries(res.results)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, output]) => `--- ${name} ---\n${output || ""}`)
      .join("\n");
  }
  return res.output || "";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceManagedWrapper(rcContent, cmd, fn) {
  const marker = `# pty-mgr: managed ${cmd} sessions`;
  const pattern = new RegExp(
    `\\n?${escapeRegex(marker)}\\n${escapeRegex(cmd)}\\(\\) \\{[\\s\\S]*?\\n\\}\\n?`,
    "m"
  );
  const match = rcContent.match(pattern);

  if (!match) return { content: rcContent, changed: false, found: false };
  if (match[0].trim() === fn.trim()) {
    return { content: rcContent, changed: false, found: true };
  }

  const prefix = match[0].startsWith("\n") ? "\n" : "";
  const suffix = match[0].endsWith("\n") ? "\n" : "";
  return {
    content: rcContent.replace(pattern, `${prefix}${fn.trim()}\n${suffix}`),
    changed: true,
    found: true,
  };
}

function detectRcFile() {
  const shell = process.env.SHELL || "";
  if (shell.endsWith("/zsh")) return join(homedir(), ".zshrc");
  if (shell.endsWith("/bash")) return join(homedir(), ".bashrc");
  // check both
  const zshrc = join(homedir(), ".zshrc");
  const bashrc = join(homedir(), ".bashrc");
  if (existsSync(zshrc)) return zshrc;
  if (existsSync(bashrc)) return bashrc;
  return join(homedir(), ".bashrc");
}

async function runSetup() {
  const { appendFileSync, readFileSync, writeFileSync } = await import("node:fs");

  console.log("pty-mgr setup");
  console.log("wrap CLI tools in managed PTY sessions.\n");
  console.log("when you type a wrapped command (e.g. claude), pty-mgr will:");
  console.log("  - auto-start the daemon if needed");
  console.log("  - create a session named <folder>-1 (increments if taken)");
  console.log("  - attach you to it (ctrl-] to detach)\n");

  const rcFile = detectRcFile();
  let rcContent = "";
  try { rcContent = readFileSync(rcFile, "utf-8"); } catch {}

  const wrapped = [];

  const SUGGESTIONS = ["claude", "codex", "gemini"];
  for (const cmd of SUGGESTIONS) {
    const answer = ask(`wrap '${cmd}'? [y/n] `);
    if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
      wrapped.push(cmd);
    }
  }

  // ask for custom commands
  while (true) {
    const custom = ask("wrap another command? (enter name or 'no') ");
    if (!custom || custom.toLowerCase() === "no" || custom.toLowerCase() === "n") break;
    const cmd = custom.trim().split(/\s+/)[0];
    if (cmd) wrapped.push(cmd);
  }

  if (wrapped.length === 0) {

    console.log("\nno commands selected. you can run 'pty-mgr setup' again anytime.");
    return;
  }

  // write to rc file
  let added = [];
  let updated = [];
  for (const cmd of wrapped) {
    const marker = `# pty-mgr: managed ${cmd} sessions`;
    const fn = wrapperFunction(cmd);
    if (rcContent.includes(marker)) {
      const replaced = replaceManagedWrapper(rcContent, cmd, fn);
      if (replaced.changed) {
        rcContent = replaced.content;
        writeFileSync(rcFile, rcContent);
        updated.push(cmd);
      } else {
        console.log(`'${cmd}' already in ${rcFile}, skipping`);
      }
      continue;
    }
    appendFileSync(rcFile, "\n" + fn + "\n");
    rcContent += "\n" + fn + "\n";
    added.push(cmd);
  }

  if (added.length > 0) {
    console.log(`\nadded to ${rcFile}: ${added.join(", ")}`);
  }
  if (updated.length > 0) {
    console.log(`\nupdated in ${rcFile}: ${updated.join(", ")}`);
  }
  if (added.length > 0 || updated.length > 0) {
    console.log("\nrestart your shell or run:");
    console.log(`  source ${rcFile}`);
  } else {
    console.log("\nnothing new to add.");
  }
}

async function cli() {
  // strip @name and --daemon <name> from argv (already consumed by getDaemonName)
  const cleaned = process.argv.slice(2).filter((a, i, arr) => {
    if (a.startsWith("@")) return false;
    if (a === "--daemon") return false;
    if (i > 0 && arr[i - 1] === "--daemon") return false;
    return true;
  });
  const [rawCommand, ...args] = cleaned;

  // command aliases - short forms
  const ALIASES = {
    n: "spawn", new: "spawn",
    w: "wrap", wrap: "wrap",
    s: "send",
    c: "capture", cap: "capture",
    st: "status",
    a: "attach",
    k: "kill",
    l: "list", ls: "list",
    i: "info",
    r: "remove", rm: "remove",
    mv: "rename", ren: "rename",
    d: "daemon",
    cfg: "config",
    x: "stop",
    log: "log",
  };
  const command = ALIASES[rawCommand] || rawCommand;

  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  if (command === "-v" || command === "--version" || command === "version") {
    console.log(VERSION);
    process.exit(0);
  }

  if (command === "demo") {
    await runDemo();
    return;
  }

  if (command === "setup") {
    await runSetup();
    return;
  }

  if (command === "tg") {
    const flags = { reply: false, timeout: 60 };
    const parts = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--reply") { flags.reply = true; continue; }
      if (args[i] === "--timeout") { flags.timeout = parseInt(args[++i], 10); continue; }
      parts.push(args[i]);
    }
    const message = parts.join(" ");
    if (!message) {
      console.error("usage: p tg <message> [--reply] [--timeout <seconds>]");
      process.exit(1);
    }
    if (!flags.reply) {
      const res = await sendCommand({ cmd: "tg-send", args: { message, session: process.env.PTY_MGR_SESSION } });
      if (!res.ok) { console.error(res.error); process.exit(1); }
      process.exit(0);
    }
    const session = process.env.PTY_MGR_SESSION;
    const res = await sendCommand({ cmd: "tg-wait", args: { message, timeout: flags.timeout * 1000, session } });
    if (!res.ok) {
      if (res.error === "TIMEOUT") { console.error("timeout: no reply"); process.exit(2); }
      console.error(res.error);
      process.exit(1);
    }
    process.stdout.write(res.reply + "\n");
    process.exit(0);
  }

  if (command === "daemon") {
    // fork into background as a true daemon (survives terminal close)
    if (!process.env.__PTY_DAEMON_CHILD) {
      const { spawn: cpSpawn } = await import("node:child_process");
      // re-exec ourselves with the same args
      // process.execPath = bun (dev) or the compiled binary
      // filter out internal /$bunfs/ paths from argv
      const realArgs = process.argv.slice(1).filter(a => !a.startsWith("/$bunfs/"));
      const child = cpSpawn(process.execPath, realArgs, {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, __PTY_DAEMON_CHILD: "1" },
      });
      // wait for daemon to report ready
      child.on("message", (msg) => {
        if (msg.ready) {
          console.log(`pty-manager daemon (${DAEMON_NAME}) started  pid=${child.pid}`);
          child.unref();
          child.disconnect();
          process.exit(0);
        }
      });
      child.on("error", (err) => {
        console.error("failed to start daemon:", err.message);
        process.exit(1);
      });
      // timeout if daemon doesn't report ready
      setTimeout(() => {
        console.error("daemon startup timeout");
        process.exit(1);
      }, 5000);
      return;
    }
    // we ARE the forked child - start the daemon
    startDaemon();
    return;
  }

  if (command === "stop") {
    const target = args[0]; // "all" or undefined (= current daemon)
    if (target === "all") {
      // find all pty-manager sockets and shut them down
      const { readdirSync } = await import("node:fs");
      const dir = join(homedir(), ".pty-manager");
      let socks = [];
      try {
        socks = readdirSync(dir).filter((f) => f.endsWith(".sock"));
      } catch { /* dir doesn't exist */ }
      // also check legacy /tmp/ location for old sockets
      try {
        const tmp = tmpdir();
        const legacy = readdirSync(tmp).filter((f) => f.startsWith("pty-manager-") && f.endsWith(".sock"));
        for (const s of legacy) socks.push("__legacy__/" + s);
      } catch {}
      if (socks.length === 0) {
        console.log("no daemons running");
        return;
      }
      const stopped = [];
      for (const sock of socks) {
        let sockFile, name;
        if (sock.startsWith("__legacy__/")) {
          const legacyName = sock.replace("__legacy__/", "");
          sockFile = join(tmpdir(), legacyName);
          name = legacyName.replace("pty-manager-", "").replace(".sock", "");
        } else {
          sockFile = join(dir, sock);
          name = sock.replace(".sock", "");
        }
        try {
          const res = await sendCommandTo(sockFile, { cmd: "shutdown" });
          if (res.ok) stopped.push(name);
        } catch {
          // stale socket, clean it up
          try { unlinkSync(sockFile); } catch {}
          stopped.push(name + " (stale)");
        }
      }
      console.log(`stopped: ${stopped.join(", ")}`);
    } else {
      // stop current daemon (based on @name or default)
      try {
        const res = await sendCommand({ cmd: "shutdown" });
        if (res.ok) console.log(`stopped: ${res.stopped}`);
      } catch {
        console.log("daemon not running");
      }
    }
    return;
  }

  if (command === "attach") {
    const name = args[0];
    if (!name) {
      console.error("usage: pty-mgr attach <name>");
      process.exit(1);
    }
    await attachToSession(name);
    return;
  }

  if (command === "watch") {
    const name = args[0];
    if (!name) {
      console.error("usage: pty-mgr watch <name> [interval]");
      process.exit(1);
    }

    let intervalMs;
    try {
      intervalMs = parseWatchIntervalMs(args[1] || "4s");
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    try {
      const first = await sendCommand({ cmd: "capture", name, args: { lines: 100 } });
      if (!first.ok) {
        console.error("error:", first.error);
        process.exit(1);
      }
      const firstHash = hashText(capturePayloadText(first));
      await sleep(intervalMs);
      const second = await sendCommand({ cmd: "capture", name, args: { lines: 100 } });
      if (!second.ok) {
        console.error("error:", second.error);
        process.exit(1);
      }
      const secondHash = hashText(capturePayloadText(second));
      console.log(firstHash === secondHash ? "done" : "working");
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // all other commands go through the daemon
  const name = args[0];

  let req;
  switch (command) {
    case "status":
      req = { cmd: "status" };
      break;
    case "config": {
      const key = args[0];
      const value = args[1];
      req = { cmd: "config", args: { key, value } };
      break;
    }
    case "spawn": {
      const hasLog = args.includes("--log");
      const spawnArgs = args.slice(1).filter((a) => a !== "--log");
      const cmd = spawnArgs[0] || "zsh";
      const cmdArgs = spawnArgs.slice(1);
      req = { cmd: "spawn", name, args: { cmd, args: cmdArgs, cwd: process.cwd(), log: hasLog } };
      break;
    }
    case "wrap": {
      const hasLog = args.includes("--log");
      const wrapArgs = args.filter((a) => a !== "--log");
      req = {
        cmd: "wrap",
        args: {
          cmd: wrapArgs[0] || "zsh",
          args: wrapArgs.slice(1),
          cwd: process.cwd(),
          log: hasLog,
        },
      };
      break;
    }
    case "send": {
      // --raw flag: send as-is, no typewriter, no enter
      const raw = args.includes("--raw");
      const textParts = args.slice(1).filter((a) => a !== "--raw");
      let text = textParts.join(" ");
      // replace literal \r and \n with actual control chars
      text = text.replace(/\\r/g, "\r").replace(/\\n/g, "\n");
      req = { cmd: "send", name, args: { text, raw, enter: !raw } };
      break;
    }
    case "capture": {
      // capture all 50, capture refa* 20, capture myagent 10
      // --screen: visible rows only (skip scrollback, good for TUI apps)
      const screenFlag = args.includes("--screen") || args.includes("-s");
      const capArgs = args.filter((a) => a !== "--screen" && a !== "-s");
      const lines = capArgs[1] ? parseInt(capArgs[1], 10) : undefined;
      req = { cmd: "capture", name, args: { lines, screen: screenFlag } };
      break;
    }
    case "list":
      req = { cmd: "list" };
      break;
    case "alive":
      req = { cmd: "alive", name };
      break;
    case "info":
      req = { cmd: "info", name };
      break;
    case "kill":
      req = { cmd: "kill", name };
      break;
    case "remove":
      req = { cmd: "remove", name };
      break;
    case "pid":
      req = { cmd: "pid", name };
      break;
    case "rename": {
      const newName = args[1];
      if (!newName) {
        console.error("usage: pty-mgr rename <old> <new>");
        process.exit(1);
      }
      req = { cmd: "rename", name, args: { newName } };
      break;
    }
    case "log": {
      // p log <name> on [format]  / p log <name> off
      const action = args[1] || "on";
      const format = args[2] || "jsonl";
      req = { cmd: "log", name, args: { action, format } };
      break;
    }
    default:
      console.error(`unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }

  try {
    const res = await sendCommand(req);

    if (!res.ok) {
      console.error("error:", res.error);
      process.exit(1);
    }


    // format output based on command
    if (command === "status") {
      const st = res.status;
      console.log(`pty-manager daemon (${st.name})`);
      console.log(`  pid:      ${st.pid}`);
      console.log(`  socket:   ${st.socket}`);
      console.log(`  uptime:   ${st.uptime}`);
      console.log(`  sessions: ${st.sessions.alive} alive, ${st.sessions.dead} dead, ${st.sessions.total} total`);
      console.log(`  screen:   ${st.config.cols}x${st.config.rows}`);
      console.log(`  cap-on-send: ${st.config.capOnSend ? "on" : "off"}`);
    } else if (command === "config") {
      if (res.config) {
        for (const [k, v] of Object.entries(res.config)) {
          console.log(`${k}: ${v}`);
        }
      }
    } else if (command === "capture") {
      if (res.results) {
        // multi-capture (all or glob)
        for (const [sname, output] of Object.entries(res.results)) {
          console.log(`--- ${sname} ---`);
          console.log(output);
          console.log();
        }
      } else {
        console.log(res.output);
      }
    } else if (command === "send") {
      if (res.output) {
        // cap-on-send enabled
        console.log(res.output);
      } else {
        console.log("ok");
      }
    } else if (command === "list") {
      if (res.sessions.length === 0) {
        console.log("no sessions");
      } else {
        for (const s of res.sessions) {
          const status = s.alive ? "alive" : `exited(${s.exitCode})`;
          console.log(
            `${s.name}  pid=${s.pid}  ${s.terminalSize}  ${status}  ${s.cmd}`
          );
        }
      }
    } else if (command === "kill") {
      if (res.killed) {
        console.log(`killed: ${res.killed.join(", ")}`);
      }
    } else if (command === "remove") {
      if (res.removed) {
        console.log(`removed: ${res.removed.join(", ")}`);
      }
    } else if (command === "rename") {
      console.log(`renamed: ${res.oldName} -> ${res.newName}`);
    } else if (command === "alive") {
      console.log(res.alive ? "alive" : "dead");
    } else if (command === "info") {
      console.log(JSON.stringify(res.info, null, 2));
    } else if (command === "spawn") {
      let out = `${name}  pid=${res.pid}`;
      if (res.logPath) out += `  log=${res.logPath}`;
      console.log(out);
    } else if (command === "wrap") {
      console.log(`${res.name}  pid=${res.pid}`);
    } else if (command === "log") {
      if (res.stopped) {
        console.log(`logging stopped${res.path ? ": " + res.path : ""}`);
      } else {
        console.log(`logging: ${res.path}  format=${res.format}`);
      }
    } else if (command === "pid") {
      console.log(res.pid);
    } else {
      console.log("ok");
    }
  } catch (err) {
    if (command === "status") {
      console.log("pty-manager daemon: not running");
    } else {
      console.error(err.message);
    }
    process.exit(1);
  }
}

const _basename0 = process.argv[0] && process.argv[0].split("/").pop();
const _basename1 = process.argv[1] && process.argv[1].split("/").pop();
const _pat = /^(pty-manager(\.mjs)?|pty-mgr(\.mjs)?|p)$/;
const _isBunCompiled = process.versions?.bun && process.argv[1]?.startsWith("/$bunfs/");
const isMain = _isBunCompiled || (_basename1 && _pat.test(_basename1)) || (_basename0 && _pat.test(_basename0));

if (isMain) {
  cli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
