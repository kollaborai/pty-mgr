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
import { dirname, join } from "node:path";
import { createWriteStream, mkdirSync, existsSync, readSync } from "node:fs";
import xterm from "@xterm/headless";

const { Terminal } = xterm;

export const SAFE_ENV_KEYS = ["PATH", "HOME", "USER", "TERM", "LANG", "SHELL",
  "NAMESPACE_ID", "AGENT_CHAIN_ROOT", "AGENT_CHAIN_CLI", "PTY_DAEMON",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

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
   * @returns {string}
   */
  capture(tailLines) {
    const buf = this.terminal.buffer.active;
    const lines = [];

    // include scrollback + visible area
    const totalLines = buf.baseY + this.terminal.rows;
    for (let i = 0; i < totalLines; i++) {
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

  write(text) {
    if (this.exited) {
      throw new Error(`session '${this.name}' has exited`);
    }
    this._pty.write(text);
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
          session._onData(new TextDecoder().decode(data));
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
  capture(name, tailLines) {
    return this.get(name).capture(tailLines);
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
      cols: 80,
      rows: 50,
      capOnSend: false,
    };

    const MAX_BUF = 1024 * 1024; // 1MB max request buffer

    const server = createServer((conn) => {
      let buf = "";
      let attached = false; // true when in attach streaming mode

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

              // clear screen, show current buffer, then SIGWINCH
              // capture gives context for shells, SIGWINCH redraws for TUIs
              conn.write("\x1b[2J\x1b[H");
              const screen = session.capture();
              if (screen) conn.write(screen + "\r\n");

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

            const res = await handleCommand(mgr, req, daemonStartedAt, config);
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

    // cleanup on exit
    const cleanup = () => {
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

async function handleCommand(mgr, req, daemonStartedAt, config) {
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
        default:
          return { ok: false, error: `unknown config key: ${key}. valid: screen, cap-on-send` };
      }
    }
    case "spawn": {
      const cmdToRun = args?.cmd || "zsh";
      const cmdArgs = args?.args || [];
      // clamp terminal size to prevent memory exhaustion
      const cols = Math.max(20, Math.min(500, args?.cols || config.cols));
      const rows = Math.max(5, Math.min(200, args?.rows || config.rows));
      const safeEnv = buildSafeEnv(args?.env);
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
      // sanitize base name for session naming
      const baseName = rawBase.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+/, "") || "session";
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
      const safeEnv = buildSafeEnv(args?.env);

      mgr.spawn(nextName, cmdToRun, cmdArgs, { cwd: clientCwd, env: safeEnv, cols, rows });
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
      mgr.sendKeys(name, args?.text || "");
      if (config.capOnSend) {
        await new Promise((r) => setTimeout(r, 1000));
        return { ok: true, output: mgr.capture(name, args?.capLines || 20) };
      }
      return { ok: true };
    }
    case "capture": {
      // "all" or glob pattern
      if (name === "all" || (name && name.endsWith("*"))) {
        const names = matchSessions(mgr, name);
        const results = {};
        for (const n of names) {
          results[n] = mgr.capture(n, args?.lines);
        }
        return { ok: true, results };
      }
      const output = mgr.capture(name, args?.lines);
      return { ok: true, output };
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

      function detach() {
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
  p spawn <name> [cmd] [args...]     create session
  p wrap [cmd] [args...]             spawn with auto-incrementing cwd name
  p attach <name>                    interactive mode (ctrl-] detach)
  p send <name> <text>               send text + enter (1s delay)
  p send <name> --raw <text>         send text without enter
  p capture <name> [lines]           capture screen output
  p capture all [lines]              capture from all sessions
  p capture <glob*> [lines]          capture matching sessions
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
  mgr.sendKeys("test-shell", "echo hello-from-pty\n");
  await sleep(600);

  console.log("3. capture (last 5 lines):");
  console.log("  ---");
  for (const l of mgr.capture("test-shell", 5).split("\n")) {
    console.log("  | " + l);
  }
  console.log("  ---\n");

  console.log("4. sendKeys: ls | head -3");
  mgr.sendKeys("test-shell", "ls | head -3\n");
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
  mgr.sendKeys("test-shell", "echo MARKER_42\n");
  const match = await mgr.waitFor("test-shell", /MARKER_42/, 5000);
  console.log("   matched:", match.trim());

  console.log("\n9. tty check:");
  mgr.sendKeys(
    "test-shell",
    'python3 -c "import sys; print(\'isatty:\', sys.stdout.isatty())"\n'
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
  local _name
  _name=$($_p wrap ${cmd} "$@" 2>&1 | awk '{print $1}')
  if [ -z "$_name" ]; then
    echo "pty-mgr: wrap failed" >&2
    return 1
  fi
  $_p attach "$_name"
}`;
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
  const { appendFileSync, readFileSync } = await import("node:fs");

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
  for (const cmd of wrapped) {
    const marker = `# pty-mgr: managed ${cmd} sessions`;
    if (rcContent.includes(marker)) {
      console.log(`'${cmd}' already in ${rcFile}, skipping`);
      continue;
    }
    const fn = wrapperFunction(cmd);
    appendFileSync(rcFile, "\n" + fn + "\n");
    added.push(cmd);
  }

  closeAsk();

  if (added.length > 0) {
    console.log(`\nadded to ${rcFile}: ${added.join(", ")}`);
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
    console.log("1.1.2");
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
      req = { cmd: "spawn", name, args: { cmd, args: cmdArgs, log: hasLog } };
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
      // --raw flag: don't append enter
      const raw = args.includes("--raw");
      const textParts = args.slice(1).filter((a) => a !== "--raw");
      let text = textParts.join(" ");
      // replace literal \r and \n with actual control chars
      text = text.replace(/\\r/g, "\r").replace(/\\n/g, "\n");
      if (!raw && !text.endsWith("\n") && !text.endsWith("\r")) {
        // send text first, wait, then send enter
        await sendCommand({ cmd: "send", name, args: { text } });
        await sleep(1000);
        req = { cmd: "send", name, args: { text: "\r" } };
      } else {
        req = { cmd: "send", name, args: { text } };
      }
      break;
    }
    case "capture": {
      // capture all 50, capture refa* 20, capture myagent 10
      const lines = args[1] ? parseInt(args[1], 10) : undefined;
      req = { cmd: "capture", name, args: { lines } };
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
