#!/usr/bin/env bun
/**
 * pty-manager.mjs (v2) - PTY-based agent session manager
 *
 * Uses:
 *   - Bun.spawn        native PTY support (no python, no native addons)
 *   - @xterm/headless   terminal emulator (parses escape codes into screen)
 *
 * capture() returns the actual rendered screen state, not raw output:
 * spinners, progress bars, cursor movements, and TUI redraws are all
 * resolved into clean text.
 *
 * v2 refactor: deduplicated the socket client, terminal-size clamps,
 * capture-stability check, `--log` wiring, telegram send, and transcript
 * listing; hardened error handling on the socket read path, the attach
 * input path, and the log write stream. Behavior and the public API are
 * unchanged (see the test suite).
 *
 * Library API:
 *   const mgr = new PtyManager();
 *   mgr.spawn('agent-1', 'claude', ['--print']);  // create session
 *   mgr.sendKeys('agent-1', 'fix the bug\r');      // send keystrokes
 *   mgr.capture('agent-1', 40);                    // rendered screen
 *   mgr.has(name) / mgr.kill(name) / mgr.list() / mgr.pid(name)
 */

import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  createWriteStream,
  mkdirSync,
  existsSync,
  readSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn as spawnChild } from "node:child_process";

// kept in sync by scripts/version-sync.cjs (rewrites this literal on release)
export const VERSION = "1.5.0";
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

// terminal-size clamps: keep buffers sane, prevent memory exhaustion from a
// hostile/typo'd size. shared by PtySession.resize and the daemon spawn/wrap.
function clampCols(value, fallback) {
  return Math.max(20, Math.min(500, value || fallback));
}
function clampRows(value, fallback) {
  return Math.max(5, Math.min(200, value || fallback));
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
   * capture the rendered screen: what you'd see now, with escape codes, cursor
   * moves and line-erases all resolved. tailLines>0 returns the last N lines;
   * opts.screen limits to visible rows (skips scrollback).
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

  /** rendered screen with ANSI color/attribute codes (via addon-serialize). */
  captureAnsi() {
    return this._serializer.serialize();
  }

  /**
   * visible content with ANSI colors, trimmed of leading/trailing empty lines.
   * reads cells individually (line by line) so colors/attributes survive.
   * tailLines>0 = last N lines.
   */
  captureAnsiCompact(tailLines) {
    const buf = this.terminal.buffer.active;
    const totalLines = buf.baseY + this.terminal.rows;
    const lines = [];

    for (let y = 0; y < totalLines; y++) {
      const line = buf.getLine(y);
      if (!line) { lines.push(""); continue; }

      let out = "";
      let keep = 0; // output length up to the last cell worth keeping
      let prevFg = -1, prevBg = -1, prevBold = false, prevDim = false;
      let prevItalic = false, prevUnder = false, prevInverse = false;

      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        if (!cell) continue;
        if (cell.getWidth() === 0) continue; // wide-char continuation cell
        // null cells (never written; TUIs skip them with cursor moves)
        // must still occupy a column, or text collapses together
        const ch = cell.getChars() || " ";

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
        if (ch !== " " || fgMode !== 0 || bgMode !== 0 ||
            bold || dim || italic || under || inverse) {
          keep = out.length;
        }
      }
      out = out.slice(0, keep); // drop trailing unstyled blanks
      if (keep > 0 && (prevFg !== -1 || prevBold)) out += "\x1b[0m";
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

  /** resize the PTY and headless terminal (clamped to sane bounds). */
  resize(cols, rows) {
    cols = clampCols(cols, cols);
    rows = clampRows(rows, rows);
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
   * start logging session output to a file. format:
   *   "raw"      - raw PTY bytes (escape codes included, replayable)
   *   "rendered" - clean screen snapshots on each data event
   *   "jsonl"    - timestamped JSON lines { t, type, data }
   */
  startLog(logPath, format = "raw") {
    if (this._logStream) this.stopLog();

    // ensure parent dir exists
    mkdirSync(dirname(logPath), { recursive: true });

    this._logPath = logPath;
    this._logFormat = format;
    this._logStream = createWriteStream(logPath, { flags: "a" });
    // a write error (disk full, perms, unlinked path) emits 'error'; without a
    // listener node throws it as uncaught and takes the daemon down. drop
    // logging on error rather than crash the session.
    this._logStream.on("error", () => { try { this.stopLog(); } catch {} });

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
   * spawn a command inside a real PTY with terminal emulation. opts: cwd, env
   * (extra vars), cols (default 100), rows (default 35), scrollback (5000).
   * returns the session name.
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
  kill(name, signal = "SIGTERM") {
    this.get(name).kill(signal);
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
      let settled = false;
      function cleanup() {
        clearTimeout(timeout);
        clearInterval(poll);
        session.events.off("data", onData);
      }

      function settle(fn, value) {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      }

      function checkCapture() {
        for (const line of session.capture().split("\n")) {
          if (re.test(line)) return line;
        }
        return null;
      }

      const timeout = setTimeout(() => {
        settle(reject, new Error(`timeout waiting for: ${pattern}`));
      }, timeoutMs);
      const poll = setInterval(() => {
        const line = checkCapture();
        if (line) settle(resolve, line);
      }, 50);

      // check current screen
      const current = checkCapture();
      if (current) {
        settle(resolve, current);
        return;
      }

      // poll on new data (re-read screen each time)
      function onData(chunk = "") {
        if (re.test(chunk)) {
          settle(resolve, chunk);
          return;
        }

        const line = checkCapture();
        if (line) settle(resolve, line);
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

// Split the daemon selector off the front of the CLI tokens.
//
// The selector is `@name` or `--daemon <name>`. It is only recognized as a
// LEADING token, or as the argument that immediately follows a leading
// `daemon`/`d` command (the documented `p daemon @myproject` form). It is NOT
// recognized anywhere else, so later `@...` tokens are preserved as data --
// e.g. `p send agent "@everyone deploy now"` keeps the message intact.
export function splitDaemonArgs(tokens = []) {
  // pull a selector off the front of an array: returns [name|null, rest]
  const takeSelector = (arr) => {
    if (arr[0] && arr[0].startsWith("@")) return [arr[0].slice(1), arr.slice(1)];
    if (arr[0] === "--daemon" && arr[1]) return [arr[1], arr.slice(2)];
    return [null, arr];
  };

  let daemon = process.env.PTY_DAEMON || "default";
  let [sel, rest] = takeSelector(tokens);
  if (sel !== null) {
    daemon = sel;
  } else if (rest[0] === "daemon" || rest[0] === "d") {
    // `daemon @name` / `daemon --daemon name`: selector trails the command
    const [sel2, after] = takeSelector(rest.slice(1));
    if (sel2 !== null) {
      daemon = sel2;
      rest = [rest[0], ...after];
    }
  }
  return { daemon, args: rest };
}

function socketPath(name) {
  // use ~/.pty-manager/ instead of /tmp to avoid world-writable dir
  const dir = join(homedir(), ".pty-manager");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${name}.sock`);
}

const { daemon: DAEMON_NAME, args: CLI_ARGS } = splitDaemonArgs(process.argv.slice(2));
const SOCKET_PATH = socketPath(DAEMON_NAME);

// ── attach input: out-of-band resize control frames ──────────────────
// While attached, the socket carries raw keystrokes. A client signals a live
// terminal resize with an APC control frame the daemon pulls out of the stream
// instead of forwarding to the pty:  ESC _ ptymgr:resize:<cols>:<rows> ESC \
// APC (ESC _) is ignored by terminals and is never produced by a keyboard, so
// it cannot collide with real input.
const RESIZE_PREFIX = Buffer.from("\x1b_ptymgr:resize:");
const RESIZE_ST = Buffer.from("\x1b\\");

// longest k (>=1) where buf's last k bytes equal prefix's first k bytes.
function suffixPrefixOverlap(buf, prefix) {
  for (let k = Math.min(buf.length, prefix.length - 1); k > 0; k--) {
    if (buf.subarray(buf.length - k).equals(prefix.subarray(0, k))) return k;
  }
  return 0;
}

// Split raw attach input into pty keystrokes and resize frames. Returns
// { forward: Buffer for the pty, resizes: [{cols,rows}], rest: Buffer to
// prepend to the next chunk }. `rest` holds an incomplete frame, or a trailing
// "ESC _…" that may begin one, so a frame split across reads reassembles. A
// lone trailing ESC is NOT held (that's the Escape key or a CSI start) so it
// forwards immediately.
export function parseAttachInput(buf) {
  const forward = [];
  const resizes = [];
  let i = 0;
  while (i < buf.length) {
    const start = buf.indexOf(RESIZE_PREFIX, i);
    if (start === -1) break;
    if (start > i) forward.push(buf.subarray(i, start));
    const st = buf.indexOf(RESIZE_ST, start + RESIZE_PREFIX.length);
    if (st === -1) {
      // incomplete frame: forward what precedes it, hold the rest
      return { forward: Buffer.concat(forward), resizes, rest: buf.subarray(start) };
    }
    const body = buf.subarray(start + RESIZE_PREFIX.length, st).toString("latin1");
    const m = body.match(/^(\d+):(\d+)$/);
    if (m) resizes.push({ cols: Number(m[1]), rows: Number(m[2]) });
    i = st + RESIZE_ST.length;
  }
  const tail = buf.subarray(i);
  let keep = suffixPrefixOverlap(tail, RESIZE_PREFIX);
  if (keep < 2) keep = 0; // never hold a lone ESC (Escape key / CSI start)
  if (tail.length > keep) forward.push(tail.subarray(0, tail.length - keep));
  return { forward: Buffer.concat(forward), resizes, rest: tail.subarray(tail.length - keep) };
}

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
      let attachInBuf = Buffer.alloc(0); // carries a split resize frame across reads

      // suppress connection errors (client disconnect, etc.)
      conn.on("error", () => {});

      // timeout: close idle connections after 30s (non-attach)
      conn.setTimeout(30000, () => {
        if (!attached) conn.destroy();
      });

      conn.on("data", async (data) => {
        // in attach mode: pull out any resize control frames (applied to the
        // session), forward the rest as raw keystrokes to the pty. the session
        // can exit between attach and this write (write() throws once exited);
        // swallow so a late keystroke can't crash the daemon's data handler.
        if (attached) {
          const { forward, resizes, rest } = parseAttachInput(
            attachInBuf.length ? Buffer.concat([attachInBuf, data]) : data
          );
          attachInBuf = rest;
          for (const { cols, rows } of resizes) {
            try { attached.resize(cols, rows); } catch {}
          }
          if (forward.length) {
            try { attached.write(forward.toString()); } catch {}
          }
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
              // size the session to the attaching client's terminal so the
              // child's winsize matches what the user actually sees. A pane
              // (tmux/iTerm split) ignores an app's own CSI-8 window resize --
              // and honoring it would resize the user's whole window -- so we
              // resize the session TO the client, the way tmux/ssh do. resize()
              // SIGWINCHes the child, which repaints at the new size; a mismatch
              // here is what makes a full-frame TUI's status line flicker and
              // pushes its bottom row off-screen. No size sent => leave as-is.
              if (req.cols && req.rows) session.resize(req.cols, req.rows);
              const cols = session.terminal.cols;
              const rows = session.terminal.rows;
              const alt = session.terminal.buffer.active.type === "alternate";
              // send initial ack with terminal size + buffer state
              conn.write(JSON.stringify({ ok: true, mode: "attach", cols, rows, alt }) + "\n");

              // replay the session's full terminal state: scrollback, screen,
              // colors, cursor, modes. history lands in the client's own
              // scrollback so it stays scrollable. if the session is inside a
              // TUI, the serializer emits the alt-screen switch itself and the
              // client pops back out on detach.
              conn.write("\x1b[2J\x1b[H" + session.captureAnsi());

              // nudge the app to repaint so live output aligns with the replay
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
                  if (session.terminal.buffer.active.type === "alternate") {
                    conn.write("\x1b[?1049l");
                  }
                  conn.write("\x1b[0m\r\n[session exited]\r\n");
                  conn.end();
                } catch {}
              };
              session.events.on("exit", onExit);

              // forward client input to pty
              attached = session;
              attachInBuf = Buffer.alloc(0);

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
      // telegram max message length is 4096; chunk under it
      for (let i = 0; i < text.length; i += 4000) {
        await telegramSend(token, chatId, text.slice(i, i + 4000));
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

// start default jsonl logging for a session, under the session's own cwd (the
// client's dir, not the daemon's frozen cwd). used by the `--log` shortcut on
// spawn/wrap; the `log` command does its own format/dir handling. returns path.
function startDefaultLog(mgr, name) {
  const logPath = join(mgr.get(name).cwd, "agents", "logs", `${name}-${Date.now()}.jsonl`);
  mgr.get(name).startLog(logPath, "jsonl");
  return logPath;
}

// POSIX single-quote escaping: wrap in '...' and replace each ' with '\''.
// Makes a token literal to the shell -- no expansion, no command substitution,
// no word splitting. Used to build the `zsh -lic` command line for `wrap`.
export function shellQuote(arg) {
  return `'${String(arg).replace(/'/g, "'\\''")}'`;
}

// one place that talks to the Telegram Bot API. returns the fetch promise so
// callers keep their existing error semantics (handleCommand's try/catch for
// the tg-send/tg-wait commands; the poller's own catch for notifications).
function telegramSend(token, chatId, text) {
  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
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
          cwd: process.cwd(),
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
      const cols = clampCols(args?.cols, config.cols);
      const rows = clampRows(args?.rows, config.rows);
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
      if (args?.log) res.logPath = startDefaultLog(mgr, name);
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

      const cols = clampCols(args?.cols, config.cols);
      const rows = clampRows(args?.rows, config.rows);

      // wrap spawns through user's login shell so shell functions/aliases work
      // (like tmux does). this means glm, nvm, conda, etc. all resolve.
      const userShell = process.env.SHELL || "/bin/zsh";
      let shellCmd, shellArgs;
      if (cmdToRun === "zsh" && cmdArgs.length === 0) {
        // bare wrap: just open a login shell
        shellCmd = userShell;
        shellArgs = ["-l"];
      } else {
        // wrap <cmd> [args]: run through login interactive shell.
        // single-quote every token so shell metacharacters in args
        // (;, |, &, $(), backticks, globs, spaces) are passed literally.
        const escaped = [cmdToRun, ...cmdArgs].map(shellQuote).join(" ");
        shellCmd = userShell;
        shellArgs = ["-lic", escaped];
      }

      // wrap inherits the daemon's real shell env (user expects their env, not
      // a sandbox), but any client-supplied env overlay is filtered to the
      // whitelist so a socket client can't inject arbitrary vars (LD_PRELOAD,
      // DYLD_INSERT_LIBRARIES, ...) into the login shell.
      const wrapEnv = { ...process.env, ...buildSafeEnv(args?.env) };

      mgr.spawn(nextName, shellCmd, shellArgs, { cwd: clientCwd, env: wrapEnv, cols, rows });
      const res = { ok: true, name: nextName, pid: mgr.pid(nextName) };
      if (args?.log) res.logPath = startDefaultLog(mgr, nextName);
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
      // default log dir: <session cwd>/agents/logs/ -- follow the session's
      // own dir, not the daemon's frozen cwd.
      const format = args?.format || "jsonl";
      const ext = format === "jsonl" ? "jsonl" : format === "rendered" ? "log" : "raw";
      const logDir = args?.dir || join(session.cwd, "agents", "logs");
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
      await telegramSend(token, chatId, msg);
      return { ok: true };
    }
    case "tg-wait": {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!token || !chatId) return { ok: false, error: "NO_TOKEN: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" };
      if (tgState.waiter) return { ok: false, error: "ALREADY_WAITING" };
      const msg = req.args?.message;
      const timeoutMs = req.args?.timeout ?? 60000;
      await telegramSend(token, chatId, msg);
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
 * client: send one newline-framed JSON command to a daemon socket and resolve
 * with the parsed JSON reply. Rejects with a friendly message when the daemon
 * is absent, and — unlike a bare JSON.parse in the data handler — turns a
 * malformed or truncated reply into a rejection instead of an uncaught throw.
 */
function requestSocket(sock, req, notRunningMsg) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(sock);
    let buf = "";
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch {}
      fn(value);
    };
    const parseAndSettle = (chunk) => {
      try { settle(resolve, JSON.parse(chunk)); }
      catch (err) { settle(reject, new Error(`bad response from daemon: ${err.message}`)); }
    };
    conn.on("error", (err) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") settle(reject, new Error(notRunningMsg));
      else settle(reject, err);
    });
    conn.on("connect", () => {
      try { conn.write(JSON.stringify(req) + "\n"); }
      catch (err) { settle(reject, err); }
    });
    conn.on("data", (data) => {
      buf += data.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) parseAndSettle(buf.slice(0, nl));
    });
    conn.on("end", () => {
      if (settled) return;
      if (buf) parseAndSettle(buf); // reply without a trailing newline
      else settle(reject, new Error(notRunningMsg));
    });
  });
}

// send to a specific socket file (used by `stop all` sweeping ~/.pty-manager).
function sendCommandTo(sock, req) {
  return requestSocket(sock, req, "daemon not running");
}

// enumerate every daemon socket: ~/.pty-manager/*.sock plus legacy
// /tmp/pty-manager-*.sock. returns [{ name, sockFile }]. shared by `stop all`
// and `daemons` so both see the same set. presence of a .sock file does not
// prove the daemon is alive -- the caller probes it.
function listDaemonSockets() {
  const found = [];
  const dir = join(homedir(), ".pty-manager");
  try {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".sock")) {
        found.push({ name: f.replace(/\.sock$/, ""), sockFile: join(dir, f) });
      }
    }
  } catch { /* dir doesn't exist yet */ }
  try {
    const tmp = tmpdir();
    for (const f of readdirSync(tmp)) {
      if (f.startsWith("pty-manager-") && f.endsWith(".sock")) {
        const name = f.replace(/^pty-manager-/, "").replace(/\.sock$/, "");
        found.push({ name, sockFile: join(tmp, f) });
      }
    }
  } catch { /* tmp unreadable */ }
  return found;
}

// send to the daemon selected by @name / --daemon / $PTY_DAEMON.
function sendCommand(req) {
  return requestSocket(SOCKET_PATH, req, "daemon not running. start with: pty-mgr daemon");
}

/**
 * attach: interactive streaming connection to a session.
 * puts terminal in raw mode, forwards keystrokes, streams output.
 * ctrl-] to detach.
 */
function attachToSession(name) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(SOCKET_PATH);
    // set on any pre-attach failure so the close handler doesn't run the
    // detach cleanup (stray "detached" + terminal resets after an error)
    let failed = false;

    conn.on("error", (err) => {
      failed = true;
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        reject(new Error("daemon not running. start with: pty-mgr daemon"));
      } else {
        reject(err);
      }
    });

    conn.on("connect", () => {
      // send attach request with our real terminal size so the daemon can size
      // the session (and its child) to us. undefined when stdout isn't a TTY;
      // the daemon then leaves the session size unchanged.
      conn.write(JSON.stringify({
        cmd: "attach",
        name,
        cols: process.stdout.columns,
        rows: process.stdout.rows,
      }) + "\n");

      let gotAck = false;
      let headerBuf = "";
      let onStdoutResize = null;

      // last-seen alt-screen state: detach pops the client back to its
      // normal screen only if the session left it in the alternate buffer
      let altActive = false;
      const trackAlt = (chunk) => {
        const h = chunk.lastIndexOf("\x1b[?1049h");
        const l = chunk.lastIndexOf("\x1b[?1049l");
        if (h !== -1 || l !== -1) altActive = h > l;
      };

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
              failed = true;
              conn.end();
              reject(new Error(ack.error));
              return;
            }
          } catch {
            failed = true;
            conn.end();
            reject(new Error("bad ack from daemon"));
            return;
          }

          gotAck = true;
          altActive = !!ack.alt;

          // NOTE: we do NOT resize our own terminal to the session. The daemon
          // has already sized the session to us (we sent our size in the attach
          // request). An app-driven CSI-8 window resize is ignored inside
          // tmux/iTerm panes and, where honored, resizes the user's entire
          // window -- which is what caused the flicker and the missing bottom row.

          // put terminal in raw mode
          process.stdin.setRawMode(true);
          process.stdin.resume();

          console.log(`attached to '${name}' (ctrl-] to detach)\r`);

          // write any remaining data after the ack
          if (remainder) {
            trackAlt(remainder);
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

          // live-resize: when our terminal changes size, tell the daemon so it
          // resizes the session (and its child's winsize) to match. Sent as an
          // out-of-band APC frame the daemon strips from the input stream.
          onStdoutResize = () => {
            const c = process.stdout.columns, r = process.stdout.rows;
            if (c && r) { try { conn.write(`\x1b_ptymgr:resize:${c}:${r}\x1b\\`); } catch {} }
          };
          process.stdout.on("resize", onStdoutResize);

          return;
        }

        // streaming mode: write pty output to terminal
        trackAlt(data);
        process.stdout.write(data);
      });

      conn.on("close", () => {
        detach();
      });

      let detached = false;
      function detach() {
        if (detached || failed) return;
        detached = true;
        if (onStdoutResize) {
          process.stdout.removeListener("resize", onStdoutResize);
          onStdoutResize = null;
        }
        if (process.stdin.isRaw) {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeAllListeners("data");
        }
        // pop the alt screen only if the session left us in one, then
        // reset SGR/cursor and any modes the replayed TUI enabled
        // (keypad, cursor keys, bracketed paste, mouse tracking)
        if (altActive) process.stdout.write("\x1b[?1049l");
        process.stdout.write(
          "\x1b[0m\x1b[?25h\x1b>\x1b[?1l\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?9l"
        );
        conn.end();
        console.log("detached");
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
  p daemons                          list all running daemons (* = current)
  p status                           daemon info + config
  p config                           show current config
  p config screen 100x50             set default terminal size
  p config cap-on-send on|off        return capture with every send
  p config send-delay <ms>           delay before enter (default 1000)
  p spawn <name> [cmd] [args...]     create session
  p wrap [cmd] [args...]             spawn with auto-incrementing cwd name
  p attach <name>                    interactive mode (ctrl-] detach)
  p view <name1> <name2> [interval]  read-only split-pane live viewer
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
  p flow list [--verbose] [--config file] list configured agent workflows
  p flow show <name> [--config file]   show one configured agent workflow
  p flow run <name> --task <text>     run a configured agent workflow
  p flow new [name] [--global]        scaffold an example flow (project cwd, or --global user config)
  p open config [editor]              open config dir in editor (--local project, --defaults packaged)
  p demo                             run self-test (no daemon needed)
  p tg <message>                     send telegram notification
  p tg <message> --reply             send message and wait for reply (blocking)
  p tg <message> --reply --timeout N wait N seconds for reply (default: 60)

shortcuts:
  n|new = spawn    w|wrap = wrap  s = send       c|cap = capture
  st = status      a = attach     v = view       k = kill
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

function clipPad(value, width) {
  const text = String(value || "").replace(/\r/g, "");
  return text.slice(0, width).padEnd(width, " ");
}

export function composeSideBySideCaptureRows({
  leftName,
  rightName,
  leftCapture = "",
  rightCapture = "",
  leftWidth,
  rightWidth,
  height,
}) {
  const rows = [];
  const visibleHeight = Math.max(0, height || 0);
  const leftLines = String(leftCapture || "").replace(/\r/g, "").split("\n");
  const rightLines = String(rightCapture || "").replace(/\r/g, "").split("\n");

  if (visibleHeight === 0) return rows;

  rows.push(`${clipPad(leftName, leftWidth)}│${clipPad(rightName, rightWidth)}`);

  for (let i = 1; i < visibleHeight; i++) {
    rows.push(
      `${clipPad(leftLines[i - 1] || "", leftWidth)}│${clipPad(rightLines[i - 1] || "", rightWidth)}`
    );
  }

  return rows;
}

async function runDemo() {
  const mgr = new PtyManager();

  console.log("--- pty-manager demo (xterm-headless) ---\n");

  const demoShell = `
print -r -- DEMO_READY
while IFS= read -r line; do
  print -r -- "> $line"
  if [ "$line" = exit ]; then
    exit 0
  fi
  eval "$line"
done
`;

  console.log("1. spawn 'test-shell' (scripted zsh pty + xterm emulation)");
  mgr.spawn("test-shell", "zsh", ["-f", "-c", demoShell], {
    cols: 120,
    rows: 30,
  });
  await mgr.waitFor("test-shell", /DEMO_READY/, 5000);

  console.log("2. sendKeys: echo hello-from-pty");
  mgr.sendKeys("test-shell", "echo hello-from-pty\r");
  await mgr.waitFor("test-shell", /^hello-from-pty$/, 5000);

  console.log("3. capture (last 5 lines):");
  console.log("  ---");
  for (const l of mgr.capture("test-shell", 5).split("\n")) {
    console.log("  | " + l);
  }
  console.log("  ---\n");

  console.log("4. sendKeys: ls | head -3");
  mgr.sendKeys("test-shell", "ls | head -3\r");
  await mgr.waitFor("test-shell", /^CHANGELOG.md$|^LICENSE$/, 5000);

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
  mgr.spawn("marker-shell", "zsh", ["-fc", "sleep 0.2; echo MARKER_42"], {
    cols: 120,
    rows: 10,
  });
  const marker = mgr.waitFor("marker-shell", /MARKER_42/, 5000);
  const match = await marker;
  console.log("   matched:", match.trim());
  await mgr.waitForExit("marker-shell", 5000).catch(() => {});

  console.log("\n9. tty check:");
  mgr.spawn("tty-check", "python3", ["-c", "import sys; print('isatty:', sys.stdout.isatty())"], {
    cols: 120,
    rows: 10,
  });
  await sleep(800);
  const ttyLine = mgr
    .capture("tty-check", 5)
    .split("\n")
    .find((l) => l.includes("isatty:"));
  console.log("   " + (ttyLine || "(not found)").trim());
  await mgr.waitForExit("tty-check", 5000).catch(() => {});

  console.log("\n10. exit scripted shell");
  mgr.sendKeys("test-shell", "exit\r");
  await mgr.waitForExit("test-shell", 5000).catch(() => {
    mgr.kill("test-shell", "SIGKILL");
  });
  console.log("    alive:", mgr.isAlive("test-shell"));

  console.log("\n11. kill disposable process");
  mgr.spawn("kill-test", "zsh", ["-fc", "sleep 30"], { cols: 120, rows: 10 });
  await sleep(200);
  mgr.kill("kill-test");
  await mgr.waitForExit("kill-test", 5000).catch(() => {
    mgr.kill("kill-test", "SIGKILL");
  });
  console.log("    alive:", mgr.isAlive("kill-test"));

  console.log("\n12. post-mortem (last 3 lines):");
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

async function verifyViewSession(name) {
  const res = await sendCommand({ cmd: "capture", name, args: { lines: 1, screen: true } });
  if (!res.ok) {
    throw new Error(`session not found: ${name}`);
  }
}

async function viewSessions(leftName, rightName, intervalMs = 500) {
  if (!leftName || !rightName) {
    throw new Error("usage: pty-mgr view <name1> <name2> [interval]");
  }

  const width = process.stdout.columns || 80;
  if (width < 21) {
    throw new Error("terminal too narrow for split view; need at least 21 columns");
  }

  await verifyViewSession(leftName);
  await verifyViewSession(rightName);

  let stopped = false;
  let drawing = false;
  let timer = null;
  const stdinWasRaw = Boolean(process.stdin.isRaw);

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(stdinWasRaw); } catch {}
      process.stdin.pause();
      process.stdin.off("data", onData);
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("exit", cleanup);
  };

  const onData = (chunk) => {
    const text = chunk.toString("utf8");
    if (text === "q" || text === "\x03") {
      cleanup();
      process.exit(0);
    }
  };

  const onSignal = () => {
    cleanup();
    process.exit(0);
  };

  const draw = async () => {
    if (stopped || drawing) return;
    drawing = true;
    try {
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      if (cols < 21) {
        process.stdout.write("\x1b[H\x1b[2Jterminal too narrow for split view; need at least 21 columns");
      } else {
        const leftWidth = Math.floor((cols - 1) / 2);
        const rightWidth = cols - 1 - leftWidth;
        const captureLines = Math.max(1, rows - 1);
        const [left, right] = await Promise.all([
          sendCommand({ cmd: "capture", name: leftName, args: { lines: captureLines, screen: true } }),
          sendCommand({ cmd: "capture", name: rightName, args: { lines: captureLines, screen: true } }),
        ]);
        if (!left.ok) throw new Error(`session not found: ${leftName}`);
        if (!right.ok) throw new Error(`session not found: ${rightName}`);
        const viewRows = composeSideBySideCaptureRows({
          leftName,
          rightName,
          leftCapture: left.output || "",
          rightCapture: right.output || "",
          leftWidth,
          rightWidth,
          height: rows,
        });
        // Position each row absolutely at column 1. A bare "\n" in raw/alt-screen
        // mode is a line feed without carriage return, so full-width rows cascade
        // and scroll instead of stacking. Explicit cursor moves avoid all wrap.
        let frame = "\x1b[H\x1b[2J";
        for (let r = 0; r < viewRows.length; r++) {
          frame += `\x1b[${r + 1};1H${viewRows[r]}`;
        }
        process.stdout.write(frame);
      }
    } catch (err) {
      cleanup();
      console.error(err.message);
      process.exit(1);
    } finally {
      drawing = false;
      if (!stopped) timer = setTimeout(draw, intervalMs);
    }
  };

  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J");
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  }
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", cleanup);

  await draw();
}

function parseFlagArgs(tokens, startIndex = 0) {
  const flags = {};
  const rest = [];
  for (let i = startIndex; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = tokens[i + 1];
      if (next == null || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      rest.push(token);
    }
  }
  return { flags, rest };
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

// capture a session (or glob/all) twice, intervalMs apart, and report whether
// the rendered bottom-100 lines are stable ("done") or still changing
// ("working"). shared by `p watch` and the flow engine's turn-completion check.
async function captureStability(name, intervalMs) {
  const capture = () => sendCommand({ cmd: "capture", name, args: { lines: 100 } });
  const first = await capture();
  if (!first.ok) throw new Error(first.error || `failed to capture ${name}`);
  const firstHash = hashText(capturePayloadText(first));
  await sleep(intervalMs);
  const second = await capture();
  if (!second.ok) throw new Error(second.error || `failed to capture ${name}`);
  return firstHash === hashText(capturePayloadText(second)) ? "done" : "working";
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function projectKeyForCwd(cwd) {
  return cwd.replace(/\//g, "-");
}

export function loadFlowConfig(configPath = "pty-mgr.config.json") {
  if (configPath && existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, "utf8"));
  }
  return { adapters: {}, flows: {} };
}

function xdgConfigHome() {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

export function userConfigPath() {
  return process.env.PTY_MGR_CONFIG || join(xdgConfigHome(), "pty-mgr", "config.json");
}

function packagedDefaultsConfigPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "pty-mgr.config.json");
}

export function findProjectConfigPath(cwd = process.cwd()) {
  let dir = cwd;
  const home = homedir();
  while (true) {
    const candidate = join(dir, "pty-mgr.config.json");
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, ".git")) || dir === home) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// merge flow configs low->high precedence; higher layers override by top-level key.
// returns { adapters, flows, scopes } where scopes maps flow name -> layer it came from.
export function resolveMergedConfig({ cwd = process.cwd(), explicitPath = null } = {}) {
  if (explicitPath) {
    const config = loadFlowConfig(explicitPath);
    const scopes = {};
    for (const name of Object.keys(config.flows || {})) scopes[name] = "config";
    return { adapters: config.adapters || {}, flows: config.flows || {}, scopes };
  }
  const layers = [];
  const defaultsPath = packagedDefaultsConfigPath();
  if (existsSync(defaultsPath)) layers.push(["default", loadFlowConfig(defaultsPath)]);
  const userPath = userConfigPath();
  if (existsSync(userPath)) layers.push(["user", loadFlowConfig(userPath)]);
  const projectPath = findProjectConfigPath(cwd);
  if (projectPath && projectPath !== defaultsPath) layers.push(["project", loadFlowConfig(projectPath)]);

  const adapters = {};
  const flows = {};
  const scopes = {};
  for (const [scope, config] of layers) {
    Object.assign(adapters, config.adapters || {});
    for (const [name, flow] of Object.entries(config.flows || {})) {
      flows[name] = flow;
      scopes[name] = scope;
    }
  }
  return { adapters, flows, scopes };
}

function exampleFlow() {
  return {
    agents: {
      writer: { kind: "codex", base: "flow-writer" },
      reviewer: { kind: "claude", base: "flow-reviewer" },
    },
    start: { to: "writer", template: "{task}" },
    turns: [
      {
        from: "writer",
        to: "reviewer",
        append:
          "Review what the other agent just did in this repository. Give specific, actionable feedback as a short numbered list, each item referencing file:line.",
      },
      {
        from: "reviewer",
        to: "writer",
        append:
          "Apply the feedback you agree with, note anything you skip and why, then report the final state. Original task: {goal}",
      },
    ],
    maxCycles: 1,
    watchInterval: "10s",
    settleMs: 1500,
  };
}

function scaffoldFlowConfig(targetPath, name) {
  const dir = dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const config = existsSync(targetPath) ? loadFlowConfig(targetPath) : { flows: {} };
  if (!config.flows) config.flows = {};
  if (config.flows[name]) {
    console.error(`flow already exists: ${name} (${targetPath})`);
    process.exit(1);
  }
  config.flows[name] = exampleFlow();
  writeFileSync(targetPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`created flow "${name}" in ${targetPath}`);
  console.log(`  edit: p open config${targetPath === userConfigPath() ? "" : " --local"}`);
  console.log(`  run:  p flow run ${name} --task "..."`);
}

function walkJsonlFiles(root, files = []) {
  root = expandHome(root);
  if (!root || !existsSync(root)) return files;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      walkJsonlFiles(path, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

function timestampMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

function getPath(obj, path) {
  if (!path) return obj;
  return String(path).split(".").reduce((value, part) => {
    if (value == null) return undefined;
    return value[part];
  }, obj);
}

function matchesWhere(obj, where = {}) {
  return Object.entries(where).every(([path, expected]) => getPath(obj, path) === expected);
}

function normalizeMessageText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function renderTemplate(value, context) {
  return String(value)
    .replaceAll("${home}", homedir())
    .replaceAll("${cwd}", context.cwd)
    .replaceAll("${projectKey}", projectKeyForCwd(context.cwd));
}

function adapterForKind(kind, config) {
  const adapter = config.adapters?.[kind];
  if (!adapter) throw new Error(`missing adapter config for agent kind: ${kind}`);
  return adapter;
}

function transcriptStartedAtMs(file, adapter) {
  const lines = readFileSync(file, "utf8").split("\n");
  const timestampPaths = adapter.sessionTimestampPaths || ["payload.timestamp", "timestamp"];

  for (const raw of lines.slice(0, 25)) {
    const line = raw.trim();
    if (!line) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    for (const path of timestampPaths) {
      const ms = timestampMs(getPath(obj, path));
      if (ms !== null) return ms;
    }
  }

  return null;
}

export function transcriptRootsForKind(kind, config, cwd = process.cwd()) {
  const adapter = adapterForKind(kind, config);
  return (adapter.roots || [])
    .map((root) => expandHome(renderTemplate(root, { cwd })))
    .filter(Boolean)
    .filter((root, index, roots) => existsSync(root) || index === roots.length - 1);
}

// flatten every .jsonl transcript under a kind's configured roots.
function transcriptFiles(kind, config, cwd = process.cwd()) {
  return transcriptRootsForKind(kind, config, cwd).flatMap((root) => walkJsonlFiles(root));
}

export function findNewestTranscript({ kind, cwd = process.cwd(), sinceMs = 0, config }) {
  const adapter = adapterForKind(kind, config);
  const candidates = transcriptFiles(kind, config, cwd)
    .map((path) => {
      const mtimeMs = statSync(path).mtimeMs;
      const startedMs = transcriptStartedAtMs(path, adapter);
      const matchMs = startedMs ?? mtimeMs;
      return { path, mtimeMs, startedMs, matchMs };
    })
    .filter((file) => file.matchMs >= sinceMs)
    .sort((a, b) => {
      const aHasStart = a.startedMs !== null;
      const bHasStart = b.startedMs !== null;
      if (aHasStart && bHasStart) return b.startedMs - a.startedMs;
      if (aHasStart !== bHasStart) return aHasStart ? -1 : 1;
      return b.mtimeMs - a.mtimeMs;
    });

  return candidates[0]?.path || null;
}

function textFromSelector(obj, selector) {
  if (selector.array) {
    const value = getPath(obj, selector.array);
    if (!Array.isArray(value)) return "";
    return value
      .filter((part) => part && typeof part === "object")
      .filter((part) => matchesWhere(part, selector.where || {}))
      .map((part) => getPath(part, selector.path || "text"))
      .filter((text) => typeof text === "string" && text.length > 0)
      .join("\n")
      .trim();
  }

  const value = getPath(obj, selector.path);
  return typeof value === "string" ? value.trim() : "";
}

function recordTextFromObject(obj, spec = {}, stripPatterns = []) {
  if (!matchesWhere(obj, spec.where || {})) return "";
  if (spec.complete && !matchesWhere(obj, spec.complete)) return "";

  let text = (spec.text || [])
    .map((selector) => textFromSelector(obj, selector))
    .filter(Boolean)
    .join("\n")
    .trim();

  for (const pattern of stripPatterns) {
    text = text.replace(new RegExp(pattern, "m"), "").trim();
  }

  return normalizeMessageText(text);
}

function assistantTextFromObject(obj, adapter) {
  return recordTextFromObject(obj, adapter.assistant || {}, adapter.stripPatterns || []);
}

function userTextFromObject(obj, adapter) {
  return recordTextFromObject(obj, adapter.user || {});
}

function messageKey(obj, lineNumber) {
  return [
    obj.timestamp,
    obj.uuid,
    obj.payload?.id,
    obj.payload?.call_id,
    lineNumber,
  ].filter(Boolean).join(":");
}

function lineFromMessageKey(key) {
  const line = Number(String(key || "").split(":").at(-1));
  return Number.isInteger(line) && line > 0 ? line : 0;
}

export function extractLastAssistantMessage(file, kind, afterKey = "", config = loadFlowConfig()) {
  const adapter = adapterForKind(kind, config);
  const lines = readFileSync(file, "utf8").split("\n");
  const afterLine = lineFromMessageKey(afterKey);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const text = assistantTextFromObject(obj, adapter);
    if (!text) continue;

    const key = messageKey(obj, i + 1);
    if (afterLine && i + 1 <= afterLine) continue;
    if (afterKey && key === afterKey) return null;
    return { key, text, file };
  }

  return null;
}

function findSentMessageInTranscript(file, kind, sentText, config = loadFlowConfig()) {
  const adapter = adapterForKind(kind, config);
  if (!adapter.user) {
    throw new Error(`agent kind ${kind} must define user parser to bind flow transcripts`);
  }

  const wanted = normalizeMessageText(sentText);
  if (!wanted) return null;

  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const text = userTextFromObject(obj, adapter);
    if (!text || text !== wanted) continue;

    return { key: messageKey(obj, i + 1), text, file };
  }

  return null;
}

export function findTranscriptForSentMessage({
  kind,
  cwd = process.cwd(),
  text,
  config,
  file,
}) {
  if (file) return findSentMessageInTranscript(file, kind, text, config);

  const candidates = transcriptFiles(kind, config, cwd)
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    const match = findSentMessageInTranscript(candidate.path, kind, text, config);
    if (match) return match;
  }

  return null;
}

function renderSteeringTemplate(template, context) {
  return String(template || "")
    .replaceAll("{task}", context.task || "")
    .replaceAll("{goal}", context.goal || context.task || "")
    .replaceAll("{lastMessage}", context.lastMessage || "")
    .replaceAll("{cycle}", String(context.cycle ?? ""))
    .replaceAll("{from}", context.from || "")
    .replaceAll("{to}", context.to || "");
}

export function buildFlowTurnMessage(turn, context) {
  if (turn.template) return renderSteeringTemplate(turn.template, context).trim();
  const text = (context.lastMessage || "").trim();
  const steering = turn.append ? renderSteeringTemplate(turn.append, context).trim() : "";
  return [text, steering].filter(Boolean).join("\n\n");
}

function flowAgentKind(agent) {
  return agent.kind;
}

function workflowForName(config, workflowName) {
  const workflow = config.flows?.[workflowName];
  if (!workflow) throw new Error(`missing flow config: ${workflowName}`);
  if (!workflow.agents || typeof workflow.agents !== "object") {
    throw new Error(`flow ${workflowName} must define agents`);
  }
  if (!workflow.start?.to) throw new Error(`flow ${workflowName} must define start.to`);
  if (!Array.isArray(workflow.turns) || workflow.turns.length === 0) {
    throw new Error(`flow ${workflowName} must define at least one turn`);
  }
  return workflow;
}

async function ensureDaemonRunning() {
  try {
    const res = await sendCommand({ cmd: "status" });
    if (res.ok) return;
  } catch {}
  throw new Error("daemon not running; start it with: p daemon");
}

async function launchFlowAgent(alias, agent, config, options, deps = {}) {
  const kind = flowAgentKind(agent);
  if (!kind) throw new Error(`flow agent ${alias} must define kind`);
  const adapter = adapterForKind(kind, config);
  const cwd = agent.cwd || options.cwd || process.cwd();
  const startedAtMs = Date.now();

  if (agent.session) {
    const transcriptFile = agent.transcript
      ? expandHome(renderTemplate(agent.transcript, { cwd }))
      : null;
    return { alias, session: agent.session, kind, cwd, startedAtMs, transcriptFile };
  }

  const command = agent.command || adapter.command || kind;
  const args = agent.args || adapter.defaultArgs || [];
  if (deps.launchAgent) return deps.launchAgent(alias, { command, args, kind, cwd, startedAtMs });

  const res = await sendCommand({
    cmd: "wrap",
    args: {
      cmd: command,
      args,
      cwd,
      base: agent.base || alias,
    },
  });
  if (!res.ok) throw new Error(res.error || `failed to launch agent ${alias}`);
  const transcriptFile = agent.transcript
    ? expandHome(renderTemplate(agent.transcript, { cwd }))
    : null;
  return { alias, session: res.name, kind, cwd, startedAtMs, transcriptFile };
}

async function sendFlowMessage(session, text, deps = {}) {
  if (deps.sendMessage) return deps.sendMessage(session, text);
  const res = await sendCommand({ cmd: "send", name: session, args: { text, enter: true } });
  if (!res.ok) throw new Error(res.error || `failed to send to ${session}`);
  return res;
}

async function waitForFlowSessionReady(session, { tries = 12, intervalMs = 1500 } = {}) {
  // A freshly spawned agent CLI (codex, claude) repaints a splash/tips screen
  // while booting; sending the first prompt during that repaint drops the
  // keystrokes. Poll until the rendered screen is non-empty and unchanged
  // between two samples (idle at its prompt). Best-effort: returns after the cap.
  let prev = null;
  for (let i = 0; i < tries; i++) {
    const cap = await sendCommand({ cmd: "capture", name: session, args: { lines: 100 } });
    const text = cap.ok ? capturePayloadText(cap) : "";
    if (prev !== null && text.trim().length > 0 && text === prev) {
      await sleep(400);
      return true;
    }
    prev = text;
    await sleep(intervalMs);
  }
  return false;
}

async function sendFlowMessageConfirmed(meta, text, config, deps = {}) {
  // Send a prompt and confirm the agent actually accepted it. A freshly booted
  // TUI can leave typed input un-submitted (the Enter races startup), which
  // strands the flow waiting for a turn that never runs. If the sent message
  // doesn't appear in the agent's transcript, nudge submit with a bare Enter.
  // The nudge is always just Enter (never re-typed) so a spurious retry can't
  // duplicate input. Returns whether acceptance was confirmed.
  await sendFlowMessage(meta.session, text, deps);
  meta.lastSentText = text;
  meta.lastUserKey = "";
  if (deps.launchAgent) return true; // dep-injected (test) mode: no real transcript
  const nudges = 2;
  for (let attempt = 0; attempt <= nudges; attempt++) {
    const polls = attempt === 0 ? 5 : 4;
    for (let i = 0; i < polls; i++) {
      await sleep(3000);
      const bound = findTranscriptForSentMessage({
        kind: meta.kind,
        cwd: meta.cwd,
        text,
        config,
        file: meta.transcriptFile,
      });
      if (bound) {
        meta.transcriptFile = bound.file;
        meta.lastUserKey = bound.key;
        return true;
      }
    }
    if (attempt < nudges) await sendFlowMessage(meta.session, "", deps);
  }
  return false;
}

async function watchFlowSession(session, intervalMs, deps = {}) {
  if (deps.watchSession) return deps.watchSession(session, intervalMs);
  return captureStability(session, intervalMs);
}

async function waitForFlowMessage({
  meta,
  config,
  afterKey,
  intervalMs,
  timeoutMs,
  watchIntervalMs,
  settleMs,
  deps,
}) {
  const started = Date.now();
  while (true) {
    const status = await watchFlowSession(meta.session, watchIntervalMs, deps);
    if (status === "done") {
      if (settleMs > 0) {
        await sleep(settleMs);
        const settled = await watchFlowSession(meta.session, watchIntervalMs, deps);
        if (settled !== "done") {
          if (settled !== "working") {
            throw new Error(`unexpected watch status for ${meta.session}: ${settled}`);
          }
          await sleep(intervalMs);
          continue;
        }
      }

      const bound = findTranscriptForSentMessage({
        kind: meta.kind,
        cwd: meta.cwd,
        text: meta.lastSentText,
        config,
        file: meta.transcriptFile,
      });
      if (bound) {
        meta.transcriptFile = bound.file;
        meta.lastUserKey = bound.key;
        const msg = extractLastAssistantMessage(
          bound.file,
          meta.kind,
          meta.lastUserKey || afterKey || "",
          config
        );
        if (msg?.text) return msg;
      }
    } else if (status !== "working") {
      throw new Error(`unexpected watch status for ${meta.session}: ${status}`);
    }

    if (timeoutMs && Date.now() - started > timeoutMs) return null;
    await sleep(intervalMs);
  }
}

export async function runFlowWorkflow(options, deps = {}) {
  const config = deps.config || loadFlowConfig(options.config);
  const workflow = workflowForName(config, options.workflow);
  const watchIntervalMs = parseWatchIntervalMs(
    options.watchInterval || workflow.watchInterval || "10s"
  );
  const intervalMs = Number(options.intervalMs ?? workflow.intervalMs ?? 1000);
  const settleMs = Number(options.settleMs ?? workflow.settleMs ?? 1500);
  const timeoutMs = Number(options.timeoutMs ?? workflow.timeoutMs ?? 0);
  const maxCycles = Number(options.maxCycles ?? workflow.maxCycles ?? 1);
  const task = options.task || "";
  const goal = options.goal || workflow.goal || task;
  const agents = {};
  const events = [];

  if (!deps.launchAgent) await ensureDaemonRunning();

  for (const [alias, agent] of Object.entries(workflow.agents)) {
    agents[alias] = await launchFlowAgent(alias, agent, config, options, deps);
    events.push({ type: "agent", alias, session: agents[alias].session, kind: agents[alias].kind });
  }

  const startAgent = agents[workflow.start.to];
  if (!startAgent) throw new Error(`flow start target not found: ${workflow.start.to}`);
  const startText = renderSteeringTemplate(workflow.start.template || "{task}", {
    task,
    goal,
    cycle: 0,
    to: workflow.start.to,
  });
  if (!deps.launchAgent) await waitForFlowSessionReady(startAgent.session);
  const startAccepted = await sendFlowMessageConfirmed(startAgent, startText, config, deps);
  events.push({ type: "send", from: "user", to: workflow.start.to, text: startText, accepted: startAccepted });
  if (!startAccepted) {
    return {
      completed: false,
      waitingFor: workflow.start.to,
      reason: "start agent never accepted the initial task (input typed but not submitted)",
      cycle: 0,
      agents,
      events,
    };
  }

  const lastKeys = {};
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    for (const turn of workflow.turns) {
      const fromMeta = agents[turn.from];
      const toMeta = agents[turn.to];
      if (!fromMeta) throw new Error(`flow turn source not found: ${turn.from}`);
      if (!toMeta) throw new Error(`flow turn target not found: ${turn.to}`);

      const msg = await waitForFlowMessage({
        meta: fromMeta,
        config,
        afterKey: lastKeys[turn.from] || "",
        intervalMs,
        timeoutMs,
        watchIntervalMs,
        settleMs,
        deps,
      });
      if (!msg) {
        return { completed: false, waitingFor: turn.from, cycle, agents, events };
      }

      lastKeys[turn.from] = msg.key;
      const text = buildFlowTurnMessage(turn, {
        task,
        goal,
        cycle: cycle + 1,
        from: turn.from,
        to: turn.to,
        lastMessage: msg.text,
      });
      const accepted = await sendFlowMessageConfirmed(toMeta, text, config, deps);
      events.push({ type: "turn", cycle: cycle + 1, from: turn.from, to: turn.to, key: msg.key, text, accepted });
    }
  }

  return { completed: true, workflow: options.workflow, cycles: maxCycles, agents, events };
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
  // daemon selector already consumed by splitDaemonArgs at module load;
  // CLI_ARGS is the remaining command + args, with data tokens preserved.
  const [rawCommand, ...args] = CLI_ARGS;

  // command aliases - short forms
  const ALIASES = {
    n: "spawn", new: "spawn",
    w: "wrap", wrap: "wrap",
    s: "send",
    c: "capture", cap: "capture",
    st: "status",
    a: "attach",
    v: "view",
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
    process.exit(0);
  }

  if (command === "setup") {
    await runSetup();
    return;
  }

  if (command === "open") {
    const sub = args[0];
    if (sub !== "config") {
      console.error("usage: p open config [editor] [--local|--defaults]");
      process.exit(1);
    }
    const { flags: openFlags, rest: openRest } = parseFlagArgs(args, 1);
    const editor = openRest[0] || process.env.VISUAL || process.env.EDITOR || "code";
    let dir;
    if (openFlags.defaults) {
      dir = dirname(packagedDefaultsConfigPath());
    } else if (openFlags.local) {
      const projectPath = findProjectConfigPath(process.cwd());
      dir = projectPath ? dirname(projectPath) : process.cwd();
    } else {
      dir = dirname(userConfigPath());
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    console.log(`opening ${dir} with ${editor}`);
    await new Promise((resolve) => {
      const child = spawnChild(editor, [dir], { stdio: "inherit" });
      child.on("error", (err) => {
        console.error(`could not launch ${editor}: ${err.message}`);
        resolve();
      });
      child.on("exit", () => resolve());
    });
    return;
  }

  if (command === "flow") {
    const subcommand = args[0];
    const { flags, rest } = parseFlagArgs(args, 1);
    if (subcommand === "new") {
      const name = rest[0] || "example";
      const target = flags.global ? userConfigPath() : join(process.cwd(), "pty-mgr.config.json");
      scaffoldFlowConfig(target, name);
      return;
    }
    if (subcommand === "list") {
      const { flows, scopes } = resolveMergedConfig({ cwd: process.cwd(), explicitPath: flags.config });
      const names = Object.keys(flows);
      if (names.length === 0) {
        console.log("no flows configured");
      } else {
        for (const name of names) {
          console.log(flags.config ? name : `${name} [${scopes[name]}]`);
          if (flags.verbose) {
            const flow = flows[name] || {};
            for (const [alias, agent] of Object.entries(flow.agents || {})) {
              console.log(`  ${alias} -> ${flowAgentKind(agent)}`);
            }
            console.log(`  start -> ${flow.start?.to || ""}, maxCycles -> ${flow.maxCycles ?? 1}`);
          }
        }
      }
      return;
    }

    if (subcommand === "show") {
      const name = args[1];
      if (!name) {
        console.error("usage: pty-mgr flow show <name>");
        process.exit(1);
      }
      const { flows } = resolveMergedConfig({ cwd: process.cwd(), explicitPath: flags.config });
      const flow = flows[name];
      if (!flow) {
        console.error(`flow not found: ${name}`);
        process.exit(1);
      }

      console.log(name);
      console.log("agents:");
      for (const [alias, agent] of Object.entries(flow.agents || {})) {
        console.log(`  ${alias} -> ${flowAgentKind(agent)}`);
      }
      console.log(`start -> ${flow.start?.to || ""}`);
      console.log("turns:");
      for (const turn of flow.turns || []) {
        console.log(`  ${turn.from || ""} -> ${turn.to || ""}`);
        console.log(`    append: ${turn.append || ""}`);
      }
      console.log(`maxCycles -> ${flow.maxCycles ?? 1}`);
      console.log(`watchInterval -> ${flow.watchInterval ?? "10s"}`);
      console.log(`settleMs -> ${flow.settleMs ?? 1500}`);
      return;
    }

    if (subcommand === "run") {
      const workflow = args[1];
      if (!workflow) {
        console.error("usage: pty-mgr flow run <name> --task <text>");
        process.exit(1);
      }
      const { flags: runFlags } = parseFlagArgs(args, 2);
      const task = runFlags.task || "";
      if (!task) {
        console.error("flow run requires --task <text>");
        process.exit(1);
      }
      const runCwd = runFlags.cwd || process.cwd();
      const merged = resolveMergedConfig({ cwd: runCwd, explicitPath: runFlags.config || flags.config });
      try {
        const result = await runFlowWorkflow({
          workflow,
          task,
          goal: runFlags.goal,
          cwd: runCwd,
          maxCycles: runFlags["max-cycles"],
          watchInterval: runFlags["watch-interval"],
          settleMs: runFlags["settle-ms"],
          timeoutMs: runFlags["timeout-ms"],
          intervalMs: runFlags["interval-ms"],
        }, { config: merged });
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      }
      return;
    }

    console.error("usage: pty-mgr flow list|show|run");
    process.exit(1);
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
      // re-exec ourselves with the same args
      // process.execPath = bun (dev) or the compiled binary
      // filter out internal /$bunfs/ paths from argv
      const realArgs = process.argv.slice(1).filter(a => !a.startsWith("/$bunfs/"));
      const child = spawnChild(process.execPath, realArgs, {
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
      const daemons = listDaemonSockets();
      if (daemons.length === 0) {
        console.log("no daemons running");
        return;
      }
      const stopped = [];
      for (const { name, sockFile } of daemons) {
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

  if (command === "daemons") {
    // read-only listing of every daemon socket. probes each for live status;
    // unlike `stop all` it never removes stale sockets. one line per daemon,
    // matching the `list` house style. current daemon (@name/$PTY_DAEMON) is
    // marked with a leading '*'.
    const daemons = listDaemonSockets();
    if (daemons.length === 0) {
      console.log("no daemons running");
      return;
    }
    for (const { name, sockFile } of daemons) {
      const marker = sockFile === SOCKET_PATH ? "*" : " ";
      let st = null;
      try {
        const res = await sendCommandTo(sockFile, { cmd: "status" });
        if (res.ok) st = res.status;
      } catch { /* stale: file exists but nothing is listening */ }
      const label = name || "(unnamed)";
      if (st) {
        const s = st.sessions;
        let line = `${marker} ${label}  pid=${st.pid}  up=${st.uptime}  ${s.alive}/${s.total} sessions`;
        if (st.cwd) line += `  ${st.cwd}`; // older daemons may not report cwd
        console.log(line);
      } else {
        console.log(`${marker} ${label}  (stale)`);
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

  if (command === "view") {
    const [leftName, rightName, intervalArg] = args;
    let intervalMs;
    try {
      intervalMs = parseWatchIntervalMs(intervalArg || "500ms");
      await viewSessions(leftName, rightName, intervalMs);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
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
      console.log(await captureStability(name, intervalMs));
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
      console.log(`  cwd:      ${st.cwd}`);
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
    // message only -- a raw error object prints a stack trace for what are
    // usually plain user-facing failures (session not found, daemon down)
    console.error("error:", err.message);
    if (process.env.PTY_MGR_DEBUG) console.error(err.stack);
    process.exit(1);
  });
}
