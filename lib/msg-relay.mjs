#!/usr/bin/env bun
/**
 * msg-relay.mjs — message bus plugin for pty-mgr (relay spec v2)
 *
 * One opt-in file that turns pty-mgr into a message bus between agents in PTY
 * sessions and you on a chat app. The model, as designed:
 *
 *  - relay-router: ONE dedicated daemon (`p relay start`, or auto-spawned when
 *    an enrolled daemon boots). Not an election — a single known process. It
 *    discovers running pty-mgr daemons over their existing sockets, keeps a
 *    registry of their sessions, auto-enrolls new ones, and bridges messages
 *    to/from chat platforms.
 *  - addressing: every session is `@daemon:session`. You are just another
 *    endpoint (you live on the chat platform). human<->agent and agent<->agent
 *    ride the same route; only the last hop differs (platform post vs send).
 *    Chat inbound also takes the short forms: `@daemon` / `@session` when
 *    unique, and no address at all when the bot bridges exactly one live
 *    session — one agent on a bot means you just talk. Bare replies chase
 *    the last speaker: whichever agent's turn most recently landed in the
 *    DM is where an unaddressed reply goes.
 *  - tier-1 (supported CLIs: claude, codex): the CLI's own end-of-turn hook is
 *    the reach-out. claude's Stop hook pipes {transcript_path,...} on stdin;
 *    codex's notify program passes {"last-assistant-message":...} as an argv
 *    JSON blob. `p relay hook` reads whichever it got, extracts the turn-final
 *    message (via the same config adapters the flow engine uses — no second
 *    parser), and posts it to the router. The agent calls nothing and never
 *    knows the relay exists. There is NO `p notify` / `p ask`: a question is
 *    just the agent's turn-final text; your reply is its next injected turn.
 *    "Going quiet" == the hook fired == the relay already sent it.
 *  - tier-2 (everything else — shells, dev servers): no hook, so it never
 *    pushes cold. When YOU message it, the router injects, watches the screen
 *    until the capture hash stops changing (same captureStability idea the
 *    flow engine runs on), and echoes the settled tail back to the chat.
 *    A session that fires a hook anyway (claude running inside a zsh
 *    session) is remembered as hook-capable and never screen-echoed again —
 *    one reply per turn, the real one.
 *  - modes per entity: assistant (1:1 DM — telegram, hand-rolled long-poll,
 *    zero deps) and channel (shared room — discord, via the Chat SDK used
 *    narrowly as transport: gateway websocket in, thread posts out; no public
 *    webhook URL needed). In a channel, mention the bot once with an
 *    @daemon:session address; the thread subscribes and follow-ups route
 *    without re-mentioning. slack/teams: the same startChannelEntity seam,
 *    not yet wired.
 *  - cold start: a daemon can declare a workspace (dir + repo + setup +
 *    ready-checks) and a default agent. Messaging a session that isn't
 *    running provisions the workspace, starts the daemon in it, spawns the
 *    agent, and replays the message — the chat gets "one moment" meanwhile.
 *    Bare and short-form messages boot too: when nothing is running, the
 *    entity's only bootable daemon comes up on session `main`.
 *
 * Config is the installable source of truth: ~/.pty-mgr/relay.json holds
 * structure (entities, enrollments); secrets stay in env vars referenced by
 * name (tokenEnv/chatEnv) so a shared config never carries credentials.
 * The router's socket lives with the other daemon sockets in ~/.pty-manager/
 * so `p daemons` lists it and `p stop all` stops it — it answers the core
 * `status` and `shutdown` commands like any other daemon.
 *
 * No new dependencies: Telegram over fetch (same as `p tg`), no sqlite. The
 * registry is in-memory (rebuilt by discovery); only the Telegram offset is
 * persisted so a router restart doesn't re-inject the backlog.
 *
 * Core integration (already wired in pty-manager.mjs):
 *   - exports reused here: listDaemonSockets, sendCommandTo,
 *     extractLastAssistantMessage, resolveMergedConfig
 *   - spawn/wrap set PTY_MGR_SESSION + PTY_MGR_DAEMON so the hook knows who
 *     it is; cli() routes `p relay ...` here; daemon boot calls
 *     maybeAutoStartRelay(DAEMON_NAME).
 */

import { createServer, createConnection } from "node:net";
import { spawn as spawnChild } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
import {
  mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync,
  copyFileSync, readSync,
} from "node:fs";

// reused from the core — no duplicate socket client, no second transcript parser
import {
  listDaemonSockets,
  sendCommandTo,
  extractLastAssistantMessage,
  resolveMergedConfig,
} from "./pty-manager.mjs";

// ── paths ──────────────────────────────────────────────────────────────
// config home is ~/.pty-mgr (it already exists — the installed binary lives
// there). The router SOCKET lives with every other daemon socket in
// ~/.pty-manager so the core's socket sweep (p daemons / p stop all) sees it.
// PTY_MGR_RELAY_HOME moves everything (config, offsets, socket) — used by the
// test suite to keep runs off the real files.
const RELAY_HOME = process.env.PTY_MGR_RELAY_HOME || join(homedir(), ".pty-mgr");
const SOCK_DIR = process.env.PTY_MGR_RELAY_HOME || join(homedir(), ".pty-manager");
const RELAY_CONFIG = join(RELAY_HOME, "relay.json");
const RELAY_OFFSETS = join(RELAY_HOME, "relay-offsets.json");
const RELAY_SOCK = join(SOCK_DIR, "relay-router.sock");
const ROUTER_NAME = "relay-router"; // excluded from discovery (it's not a pty daemon)

function ensureHome() {
  mkdirSync(RELAY_HOME, { recursive: true, mode: 0o700 });
  mkdirSync(SOCK_DIR, { recursive: true, mode: 0o700 });
}

// ── config: the installable source of truth ────────────────────────────
// {
//   entities: { "<name>": { platform, mode, tokenEnv, chatEnv, userName } },
//     - platform telegram (assistant, hand-rolled fetch) or discord (channel,
//       via the Chat SDK's gateway — no public URL needed)
//   daemons: { "<daemon>": {
//       entity: "<entity name>",           // which bot bridges this daemon
//       workspace: {                       // optional: cold-start provisioning
//         dir: "~/work/marketing",         // where the daemon's agents live
//         repo: "git@github.com:o/r.git",  // optional: cloned into dir if absent
//         branch: "main",                  // optional
//         setup: ["bun install"],          // optional post-clone commands
//         ready: [                         // hot/cold checks, extensible:
//           { "check": "dir-exists" },     //   built-ins + `cmd` escape hatch
//           { "check": "git-repo" },
//           { "check": "cmd", "run": "test -f .env" }
//         ],
//         provisionTimeoutMs: 600000
//       },
//       agent: { kind: "claude" }          // what a cold-addressed session runs;
//                                          // kind resolves command/args through
//                                          // the flow adapters. command/args
//                                          // override the adapter if set.
//   } },
//   enrollments: { "<daemon>": "<entity>" },  // legacy form, still honored
//   supported: ["claude", "codex"]            // launch cmds that are tier-1
// }
// A message to a cold @daemon:session heals the whole chain: provision the
// workspace -> start the daemon (cwd = workspace.dir) -> spawn the agent ->
// deliver the original message. The chat gets "one moment" while it happens.
function defaultConfig() {
  return { entities: {}, daemons: {}, enrollments: {}, supported: ["claude", "codex"] };
}

// merged per-daemon view: new `daemons` section wins, legacy `enrollments`
// string form fills the entity when the new form doesn't name one
function daemonConfig(cfg, name) {
  const d = cfg.daemons?.[name] || {};
  const entity = d.entity || cfg.enrollments?.[name] || null;
  return { entity, workspace: d.workspace || null, agent: d.agent || null };
}

export function loadRelayConfig() {
  if (!existsSync(RELAY_CONFIG)) return defaultConfig();
  try { return { ...defaultConfig(), ...JSON.parse(readFileSync(RELAY_CONFIG, "utf8")) }; }
  catch { return defaultConfig(); }
}

export function saveRelayConfig(cfg) {
  ensureHome();
  writeFileSync(RELAY_CONFIG, JSON.stringify(cfg, null, 2) + "\n");
  return RELAY_CONFIG;
}

export function initRelayConfig() {
  if (existsSync(RELAY_CONFIG)) return { path: RELAY_CONFIG, created: false };
  saveRelayConfig(defaultConfig());
  return { path: RELAY_CONFIG, created: true };
}

export function relayConfigured() {
  return existsSync(RELAY_CONFIG);
}

function loadOffsets() {
  if (!existsSync(RELAY_OFFSETS)) return {};
  try { return JSON.parse(readFileSync(RELAY_OFFSETS, "utf8")); } catch { return {}; }
}
function saveOffsets(offsets) {
  ensureHome();
  try { writeFileSync(RELAY_OFFSETS, JSON.stringify(offsets)); } catch {}
}

// ── platform transport (assistant mode) ────────────────────────────────
// One place that talks to Telegram, same Bot API calls as the core's tg
// helpers. whatsapp/slack/teams slot in behind these two calls — TODO(channel).
async function telegramGetUpdates(token, lastUpdateId) {
  // offset is last handled id + 1: telegram treats the offset as an ack and
  // re-delivers anything >= offset, so sending the raw id would loop forever.
  const url = `https://api.telegram.org/bot${token}/getUpdates`
    + `?timeout=25&offset=${lastUpdateId + 1}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const data = await res.json();
  if (data.ok === false) throw new Error(`getUpdates: ${data.description || res.status}`);
  return data.result || [];
}

async function telegramSend(token, chatId, text) {
  // 4096-char message cap: chunk under it. Plain text (no parse_mode) so code
  // fences and markdown from agent output can never trip a parse 400.
  for (let i = 0; i < text.length; i += 4000) {
    const body = JSON.stringify({ chat_id: chatId, text: text.slice(i, i + 4000) });
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (res.status !== 429) break;
      // rate-limited: honor retry_after once, then give up on this chunk
      const data = await res.json().catch(() => ({}));
      await sleep(((data.parameters?.retry_after || 3) + 1) * 1000);
    }
  }
}

// resolve an entity's secrets from env at use time — never from the config file.
// discord needs publicKey (interaction signature key) and optionally the
// application id alongside the bot token; both live in the dev portal.
function entityCreds(entity) {
  return {
    token: process.env[entity?.tokenEnv || ""] || "",
    chatId: process.env[entity?.chatEnv || ""] || "",
    publicKey: process.env[entity?.publicKeyEnv || "DISCORD_PUBLIC_KEY"] || "",
    appId: process.env[entity?.appIdEnv || "DISCORD_APPLICATION_ID"] || "",
  };
}

// post into a channel thread, chunked under discord's 2000-char message cap
async function channelPost(thread, text) {
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1900) {
    await thread.post(s.slice(i, i + 1900));
  }
}

// ── addressing ─────────────────────────────────────────────────────────
// The grammar is strict `@daemon:session [message]` — colon required. A space
// form ("@marketing restart the build") would silently parse a message word as
// a session name and misroute, so it is deliberately NOT accepted. A bare
// message (no @) resolves against the chat's last-addressed target; a bare
// address (no message) just moves focus.
export function parseAddress(text) {
  const m = String(text || "").trim()
    .match(/^@([a-zA-Z0-9][a-zA-Z0-9._-]*):([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*([\s\S]*)$/);
  if (!m) return null;
  return { daemon: m[1], session: m[2], rest: m[3].trim() };
}

function addr(daemon, session) { return `@${daemon}:${session}`; }

// session name that bare/short-form messages boot on a cold daemon — full
// @daemon:session addressing can still cold-start any name it likes
const DEFAULT_SESSION = "main";

// a daemon that can be booted by messaging it: coldStart() owns anything
// with a workspace or a configured agent
function coldStartable(cfg, daemon) {
  const d = daemonConfig(cfg, daemon);
  return Boolean(d.workspace || d.agent);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hashText(value) { return createHash("sha256").update(value || "").digest("hex"); }

// ── workspace provisioning (cold-start) ────────────────────────────────
// "hot or cold": a workspace is hot when every `ready` check passes. Checks
// are a named-built-in list plus a `cmd` escape hatch, so new conditions are
// config, not code. Defaults: dir-exists, plus git-repo when a repo is set.
function expandTilde(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function runShell(cmd, cwd, timeoutMs = 600000) {
  // login shell so git/ssh/nvm resolve exactly like the user's terminal —
  // "assume they're logged in" is the design: no credential handling here
  return new Promise((resolve) => {
    const child = spawnChild(process.env.SHELL || "/bin/zsh", ["-lc", cmd], {
      cwd, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const cap = (d) => { out = (out + d.toString()).slice(-4000); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, out: err.message }); });
  });
}

export function workspaceReady(ws) {
  const dir = expandTilde(ws.dir);
  const checks = ws.ready
    || [{ check: "dir-exists" }, ...(ws.repo ? [{ check: "git-repo" }] : [])];
  for (const c of checks) {
    switch (c.check) {
      case "dir-exists":
        if (!existsSync(dir)) return { ready: false, failed: "dir-exists" };
        break;
      case "git-repo":
        if (!existsSync(join(dir, ".git"))) return { ready: false, failed: "git-repo" };
        break;
      case "cmd": {
        if (!existsSync(dir)) return { ready: false, failed: `cmd: ${c.run}` };
        // sync-ish gate: cmd checks run through Bun's spawnSync via zsh -lc
        const res = Bun.spawnSync([process.env.SHELL || "/bin/zsh", "-lc", String(c.run || "true")], { cwd: dir });
        if (res.exitCode !== 0) return { ready: false, failed: `cmd: ${c.run}` };
        break;
      }
      default:
        return { ready: false, failed: `unknown check: ${c.check}` };
    }
  }
  return { ready: true };
}

// clone + setup. Returns { ok } or { ok:false, error, out } with the tail of
// the failing command's output so the chat error is diagnosable.
export async function provisionWorkspace(ws) {
  const dir = expandTilde(ws.dir);
  const timeoutMs = ws.provisionTimeoutMs || 600000;
  const parent = join(dir, "..");
  mkdirSync(parent, { recursive: true });
  if (ws.repo && !existsSync(join(dir, ".git"))) {
    const branch = ws.branch ? `--branch ${JSON.stringify(ws.branch)} ` : "";
    const clone = await runShell(
      `git clone ${branch}${JSON.stringify(ws.repo)} ${JSON.stringify(dir)}`, parent, timeoutMs);
    if (clone.code !== 0) return { ok: false, error: "git clone failed", out: clone.out };
  } else {
    mkdirSync(dir, { recursive: true });
  }
  for (const cmd of ws.setup || []) {
    const res = await runShell(cmd, dir, timeoutMs);
    if (res.code !== 0) return { ok: false, error: `setup failed: ${cmd}`, out: res.out };
  }
  return { ok: true };
}

// ── the router ─────────────────────────────────────────────────────────
// Lives in the relay-router process. Discovers daemons, keeps the registry,
// routes messages both ways. Holds no PTY sessions of its own — it drives
// other daemons' sessions over their sockets.
export class RelayRouter {
  constructor(config) {
    this.config = config || loadRelayConfig();
    this.running = false;
    this.startedAt = Date.now();
    // registry: daemon -> { sock, entity|null, sessions: Map<name, {cmd, tier, alive}> }
    this.registry = new Map();
    // bare-follow-up focus: chat key -> { daemon, session }. assistant mode
    // keys by chat id; channel mode keys by entity:threadId (threads give the
    // per-conversation correlation a flat DM never had)
    this.lastTarget = new Map();
    // persisted telegram cursor per entity (survives a router restart)
    this.offsets = loadOffsets();
    // observability: last 20 turn events, surfaced by relay-status
    this.recentTurns = [];
    // channel mode: live SDK bots per entity, and thread handles per agent
    // address so an agent's turn-final knows which thread to post into
    this.channels = new Map();
    this.channelThreads = new Map();
    // one cold-start at a time per address
    this.provisioning = new Set();
    // addresses that have proven they push their own turns (a hook turn
    // arrived at least once). A hook-capable session never gets the tier-2
    // screen-echo — otherwise every chat message earns two replies: the
    // agent's real turn-final plus a raw TUI capture.
    this.hookCapable = new Set();
  }

  entityForDaemon(daemon) {
    const name = daemonConfig(this.config, daemon).entity;
    if (!name) return null;
    const entity = this.config.entities?.[name];
    return entity ? { name, ...entity } : null;
  }

  // classify by launch command: a supported bin (claude/codex) is tier-1
  // (hook pushes its turns), everything else is tier-2 (inject + settle-echo).
  // `list` reports cmd as the full joined command line, so take the binary.
  tierFor(cmd) {
    const supported = this.config.supported || ["claude", "codex"];
    const bin = String(cmd || "").trim().split(/\s+/)[0].split("/").pop();
    return supported.includes(bin) ? 1 : 2;
  }

  // Poll every daemon's `list` and rebuild the registry — this IS the
  // auto-enroll: a session that appears in a listing is addressable on the
  // next tick. Reuses the exact socket protocol the CLI uses; zero
  // daemon-side changes. ALL running daemons register (agent<->agent works
  // unenrolled); the enrollment only decides which chat entity bridges it.
  async discover() {
    const seen = new Set();
    for (const { name, sockFile } of listDaemonSockets()) {
      if (name === ROUTER_NAME || seen.has(name)) continue;
      seen.add(name);
      let res;
      try { res = await sendCommandTo(sockFile, { cmd: "list" }); }
      catch { this.registry.delete(name); continue; }
      if (!res?.ok) { this.registry.delete(name); continue; }
      const sessions = new Map();
      for (const s of res.sessions || []) {
        sessions.set(s.name, { cmd: s.cmd, tier: this.tierFor(s.cmd), alive: s.alive });
      }
      this.registry.set(name, { sock: sockFile, entity: this.entityForDaemon(name), sessions });
    }
    // daemons whose socket disappeared entirely
    for (const name of [...this.registry.keys()]) {
      if (!seen.has(name)) this.registry.delete(name);
    }
  }

  resolve(daemon, session) {
    const d = this.registry.get(daemon);
    const s = d?.sessions.get(session);
    if (!d || !s) return null;
    return { daemon, session, sock: d.sock, ...s };
  }

  // Injecting into a mid-turn agent interleaves bytes into whatever is on its
  // screen, so wait (bounded) for the rendered capture to hold still — the
  // same stability signal the flow engine trusts. Best-effort: after the cap
  // we deliver anyway (a never-idle tier-2 process like a dev server would
  // otherwise be unreachable).
  async idleGate(sock, session, { tries = 8, intervalMs = 1200 } = {}) {
    let prev = null;
    for (let i = 0; i < tries; i++) {
      let cap;
      try { cap = await sendCommandTo(sock, { cmd: "capture", name: session, args: { lines: 100 } }); }
      catch { return false; }
      const text = cap?.ok ? cap.output || "" : "";
      if (prev !== null && text === prev) return true;
      prev = text;
      await sleep(intervalMs);
    }
    return false;
  }

  // Deliver text into a target session (human->agent or agent->agent). Reuses
  // the core `send` command WITH enter:true — the daemon then does the proven
  // two-write dance (text, settle delay, then \r as its own write), which is
  // what makes multi-line text inside a bracketed paste still submit.
  async deliver(target, text, { gate = true } = {}) {
    let t = this.resolve(target.daemon, target.session);
    if (!t) {
      // registry can be up to one tick stale — refresh once before failing
      await this.discover().catch(() => {});
      t = this.resolve(target.daemon, target.session);
    }
    if (!t) return { ok: false, error: `unknown target ${addr(target.daemon, target.session)}` };
    if (!t.alive) return { ok: false, error: `${addr(target.daemon, target.session)} is not alive` };
    if (gate) await this.idleGate(t.sock, target.session);
    try {
      const res = await sendCommandTo(t.sock, {
        cmd: "send", name: target.session, args: { text, enter: true },
      });
      return res?.ok ? { ok: true, tier: t.tier, sock: t.sock }
        : { ok: false, error: res?.error || "send failed" };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Tier-2 has no hook, so after a chat-initiated injection the router itself
  // watches the screen: wait for output to start, poll until two consecutive
  // captures hash identical (settled), then echo the tail back to the chat.
  // This mirrors the auto-capture behavior today's tg /send path already has.
  async settleEcho(target, reply, { timeoutMs = 120000, intervalMs = 3000 } = {}) {
    if (this.hookCapable.has(addr(target.daemon, target.session))) return;
    const t = this.resolve(target.daemon, target.session);
    if (!t) return;
    await sleep(2000);
    const started = Date.now();
    let prev = null;
    while (Date.now() - started < timeoutMs) {
      let cap;
      try { cap = await sendCommandTo(t.sock, { cmd: "capture", name: target.session, args: { lines: 100 } }); }
      catch { return; }
      const text = cap?.ok ? cap.output || "" : "";
      const h = hashText(text);
      if (prev !== null && h === prev) {
        let tail;
        try {
          const res = await sendCommandTo(t.sock, { cmd: "capture", name: target.session, args: { lines: 30 } });
          tail = res?.ok ? res.output : "";
        } catch { return; }
        // the hook may have raced us mid-watch (claude inside a zsh session
        // classifies tier-2 but still fires its Stop hook) — its turn-final
        // already went out, so drop the screen capture
        if (this.hookCapable.has(addr(target.daemon, target.session))) return;
        if (tail) await reply(`${addr(target.daemon, target.session)}:\n${tail}`);
        return;
      }
      prev = h;
      await sleep(intervalMs);
    }
  }

  // the command this router was launched with — reused to fork daemons the
  // same way ensureRelayRouter forks the router (dev script or compiled)
  selfCmd() {
    const base = process.argv[1] && !process.argv[1].startsWith("/$bunfs/")
      ? [process.argv[1]] : [];
    return [process.execPath, ...base];
  }

  // Cold-start: a message to a session that isn't there heals the chain —
  // provision the workspace, start the daemon (cwd = workspace dir), spawn
  // the agent, then deliver the original message (auto-replay; the "one
  // moment" reply covers the gap). Returns { handled: true } when this path
  // owned the message.
  async coldStart(entity, target, body, reply) {
    const key = addr(target.daemon, target.session);
    const dcfg = daemonConfig(this.config, target.daemon);
    if (!dcfg.workspace && !dcfg.agent) return { handled: false };
    if (this.provisioning.has(key)) {
      await reply(`${key} is still setting up — one moment`);
      return { handled: true };
    }
    this.provisioning.add(key);
    try {
      const ws = dcfg.workspace;
      const dir = ws ? expandTilde(ws.dir) : process.cwd();

      // 1. environment hot? else provision
      if (ws) {
        const state = workspaceReady(ws);
        if (!state.ready) {
          await reply(`one moment — setting up ${key} (${state.failed}${ws.repo ? `, cloning ${ws.repo}` : ""})`);
          const prov = await provisionWorkspace(ws);
          if (!prov.ok) {
            await reply(`${key} setup failed — ${prov.error}\n${(prov.out || "").split("\n").slice(-8).join("\n")}`);
            return { handled: true };
          }
        }
      }

      // 2. daemon running? else fork one rooted in the workspace
      await this.discover().catch(() => {});
      if (!this.registry.has(target.daemon)) {
        await reply(`one moment — starting @${target.daemon}`);
        const [exe, ...rest] = this.selfCmd();
        const child = spawnChild(exe, [...rest, `@${target.daemon}`, "daemon"], {
          cwd: dir, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        await new Promise((res) => {
          let done = false;
          const finish = () => { if (!done) { done = true; try { child.unref(); child.disconnect(); } catch {} res(); } };
          child.on("message", (m) => { if (m?.ready) finish(); });
          child.on("error", finish);
          setTimeout(finish, 5000);
        });
        await this.discover().catch(() => {});
        if (!this.registry.has(target.daemon)) {
          await reply(`couldn't start @${target.daemon}`);
          return { handled: true };
        }
      }

      // 3. session alive? else spawn the configured agent in the workspace.
      // agent.command/args override; otherwise kind resolves through the same
      // adapters the flow engine launches with.
      const d = this.registry.get(target.daemon);
      const existing = d.sessions.get(target.session);
      if (!existing || !existing.alive) {
        if (existing) {
          try { await sendCommandTo(d.sock, { cmd: "remove", name: target.session }); } catch {}
        }
        const spec = dcfg.agent || {};
        const kind = spec.kind || "claude";
        let command = spec.command, cargs = spec.args;
        if (!command) {
          try {
            const adapter = resolveMergedConfig({ cwd: dir }).adapters?.[kind];
            command = adapter?.command || kind;
            cargs = cargs || adapter?.defaultArgs || [];
          } catch { command = kind; cargs = cargs || []; }
        }
        const spawned = await sendCommandTo(d.sock, {
          cmd: "spawn", name: target.session,
          args: { cmd: command, args: cargs || [], cwd: dir },
        }).catch((err) => ({ ok: false, error: err.message }));
        if (!spawned?.ok) {
          await reply(`couldn't spawn ${key} — ${spawned?.error || "spawn failed"}`);
          return { handled: true };
        }
        // let the CLI's boot splash settle before typing into it
        await this.idleGate(d.sock, target.session, { tries: 12, intervalMs: 1500 });
        await this.discover().catch(() => {});
      }

      // 4. auto-replay the original message
      const out = await this.deliver(target, body);
      if (!out.ok) {
        await reply(`${key} is up but delivery failed — ${out.error}`);
        return { handled: true };
      }
      if (out.tier === 2) this.settleEcho(target, reply).catch(() => {});
      return { handled: true, ok: true };
    } finally {
      this.provisioning.delete(key);
    }
  }

  // daemons enrolled to a chat entity per CONFIG (registry only knows the
  // running ones — cold daemons exist only here)
  enrolledDaemons(entityName) {
    return [...new Set([
      ...Object.keys(this.config.daemons || {}),
      ...Object.keys(this.config.enrollments || {}),
    ])].filter((d) => daemonConfig(this.config, d).entity === entityName);
  }

  // every live session reachable from one chat entity: the daemons enrolled
  // to it, flattened to [{daemon, session}] — the space bare/partial
  // addresses resolve against
  liveTargetsFor(entityName) {
    const out = [];
    for (const [dname, d] of this.registry) {
      if (daemonConfig(this.config, dname).entity !== entityName) continue;
      for (const [sname, s] of d.sessions) {
        if (s.alive) out.push({ daemon: dname, session: sname });
      }
    }
    return out;
  }

  // "@x" without a colon: x may name an enrolled daemon (unique live session
  // required) or a unique live session on any enrolled daemon. Returns
  // { target } when it resolves, { error } when it's address-intent but
  // ambiguous/dead, null when x means nothing here (caller falls back to
  // treating the text as plain message content).
  resolvePartial(entityName, x) {
    const live = this.liveTargetsFor(entityName);
    if (daemonConfig(this.config, x).entity === entityName) {
      const inDaemon = live.filter((t) => t.daemon === x);
      if (inDaemon.length === 1) return { target: inDaemon[0] };
      if (inDaemon.length > 1) {
        return { error: `which session? ${inDaemon.map((t) => addr(t.daemon, t.session)).join("  ")}` };
      }
      // nothing running on it — bootable daemons boot (deliver fails ->
      // coldStart provisions, forks, spawns, replays)
      if (coldStartable(this.config, x)) return { target: { daemon: x, session: DEFAULT_SESSION } };
      return { error: `@${x} has no live sessions` };
    }
    const byName = live.filter((t) => t.session === x);
    if (byName.length === 1) return { target: byName[0] };
    if (byName.length > 1) {
      return { error: `ambiguous: ${byName.map((t) => addr(t.daemon, t.session)).join("  ")}` };
    }
    return null;
  }

  // An inbound chat message -> route to a session. Resolution order:
  // explicit @daemon:session, partial @daemon or @session when unique, the
  // chat's focus (last target the human addressed OR last agent whose turn
  // landed in this DM — replies chase the speaker), and finally the entity's
  // only live session (one agent on the bot = no addressing needed).
  // Undeliverable -> error back into the chat, never a silent drop. `reply` abstracts the
  // return path (telegram send vs channel-thread post); `thread` is the
  // channel thread handle, recorded so the agent's turn-finals route back
  // to it.
  async onInbound(entity, chatKey, text, reply, thread) {
    reply = reply || ((t) => this.sendTo(entity, chatKey, t));
    const parsed = parseAddress(text);
    let target, body;
    if (parsed) {
      target = { daemon: parsed.daemon, session: parsed.session };
      body = parsed.rest;
    } else {
      const pm = String(text || "").trim()
        .match(/^@([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*([\s\S]*)$/);
      if (pm) {
        const r = this.resolvePartial(entity.name, pm[1]);
        if (r?.error) return reply(r.error);
        if (r?.target) { target = r.target; body = pm[2].trim(); }
        // unresolvable "@word" falls through: with a focused target it's
        // message content (e.g. "@here check this"), not an address
      }
      if (!target) {
        target = this.lastTarget.get(String(chatKey));
        body = String(text || "").trim();
      }
      if (!target) {
        const live = this.liveTargetsFor(entity.name);
        if (live.length === 1) target = live[0];
        else if (live.length > 1) {
          return reply(`address an agent first:  ${live.map((t) => addr(t.daemon, t.session)).join("  ")}`);
        } else {
          // nothing running anywhere on this bot: exactly one bootable
          // daemon means "hi" boots it — several means pick one
          const cold = this.enrolledDaemons(entity.name)
            .filter((d) => coldStartable(this.config, d));
          if (cold.length === 1) target = { daemon: cold[0], session: DEFAULT_SESSION };
          else if (cold.length > 1) {
            return reply(`nothing running — boot one:  ${cold.map((d) => `@${d}:${DEFAULT_SESSION}`).join("  ")}`);
          }
        }
      }
    }

    if (!target) {
      return reply("address an agent first:  @daemon:session <message>");
    }
    // inbound from a chat only reaches daemons enrolled to that entity — the
    // enrollment is what maps a bot to its daemons
    if (daemonConfig(this.config, target.daemon).entity !== entity.name) {
      return reply(`@${target.daemon} is not enrolled to '${entity.name}' (p relay enroll ${target.daemon} ${entity.name})`);
    }
    const bindThread = () => {
      this.lastTarget.set(String(chatKey), target);
      if (thread) this.channelThreads.set(addr(target.daemon, target.session), thread);
    };
    if (!body) { bindThread(); return; } // bare address = set focus

    let out = await this.deliver(target, body);
    if (!out.ok) {
      // unknown/dead target on a daemon with workspace/agent config is not an
      // error — it's a cold start
      const cold = await this.coldStart(entity, target, body, reply);
      if (cold.handled) { if (cold.ok) bindThread(); return; }
      // a dead/unknown target also drops focus so bare follow-ups stop
      // resolving to a corpse
      const focused = this.lastTarget.get(String(chatKey));
      if (focused && focused.daemon === target.daemon && focused.session === target.session) {
        this.lastTarget.delete(String(chatKey));
      }
      return reply(`couldn't reach ${addr(target.daemon, target.session)} — ${out.error}`);
    }
    bindThread();
    // tier-1 replies arrive via the agent's own hook; tier-2 needs the router
    // to watch and echo (fire-and-forget so the poll loop isn't blocked)
    if (out.tier === 2) this.settleEcho(target, reply).catch(() => {});
  }

  // An agent's turn-final message (posted by its hook) -> out to the chat,
  // tagged with its address so a shared bot's agents stay distinguishable.
  // Assistant entities post to the configured DM; channel entities post into
  // the thread that most recently addressed this agent (no thread = nobody
  // is talking to it in the channel -> drop).
  async relayTurn(daemon, session, message) {
    this.hookCapable.add(addr(daemon, session)); // proof: hooks fire here
    const entity = this.entityForDaemon(daemon);
    const event = {
      at: new Date().toISOString(), daemon, session,
      delivered: false, preview: String(message || "").slice(0, 80),
    };
    this.recentTurns.push(event);
    if (this.recentTurns.length > 20) this.recentTurns.shift();
    if (!entity || !message) return; // unenrolled daemon or empty turn: drop
    const tagged = `${addr(daemon, session)}: ${message}`;
    if ((entity.mode || "assistant") === "channel") {
      const thread = this.channelThreads.get(addr(daemon, session));
      if (!thread) return;
      try { await channelPost(thread, tagged); event.delivered = true; } catch {}
      return;
    }
    const { token, chatId } = entityCreds(entity);
    if (!token || !chatId) return;
    await this.sendDM(token, chatId, tagged);
    event.delivered = true;
    // replies chase the last speaker: once an agent's turn lands in the DM,
    // a bare reply goes back to that agent — until the human addresses
    // someone else explicitly
    this.lastTarget.set(String(chatId), { daemon, session });
  }

  // seam over the raw platform send (stubbable; errors propagate so a failed
  // delivery never counts as delivered or steals focus)
  sendDM(token, chatId, text) { return telegramSend(token, chatId, text); }

  async sendTo(entity, chatId, text) {
    const { token } = entityCreds(entity);
    if (token) await telegramSend(token, chatId, text).catch(() => {});
  }

  // Long-poll one entity's inbound for the router's lifetime. Offset advances
  // BEFORE handling (same semantics as the core tgPoller): a poison update
  // must never be able to re-inject into a terminal forever — for a bus that
  // types into live shells, at-most-once beats at-least-once.
  async pollEntity(name, entity) {
    while (this.running) {
      const { token, chatId } = entityCreds(entity);
      if (!token) { await sleep(15000); continue; } // creds may appear later
      try {
        const updates = await telegramGetUpdates(token, this.offsets[name] || 0);
        for (const u of updates) {
          this.offsets[name] = u.update_id;
          saveOffsets(this.offsets);
          const msg = u.message;
          if (!msg?.text) continue;
          // assistant mode is single-user: only the configured chat/user id
          // may drive terminals — same check the core tgPoller enforces.
          // Strangers get silence (a reply would confirm the bot is live).
          const fromOk = chatId &&
            (String(msg.chat?.id) === chatId || String(msg.from?.id) === chatId);
          if (!fromOk) continue;
          try { await this.onInbound(entity, msg.chat.id, msg.text); } catch {}
        }
      } catch {
        await sleep(3000);
      }
    }
  }

  // Channel mode: the Chat SDK is the transport, used narrowly — receive
  // mentions/thread messages, post replies. Gateway websocket mode, so a
  // laptop-resident router needs no public webhook URL. First mention
  // subscribes the thread; after that every thread message routes without
  // re-mentioning the bot.
  async startChannelEntity(name, entity) {
    if (entity.platform !== "discord") {
      console.error(`relay: channel entity '${name}': platform '${entity.platform}' not implemented (discord only for now)`);
      return;
    }
    let Chat, createDiscordAdapter, createMemoryState;
    try {
      ({ Chat } = await import("chat"));
      ({ createDiscordAdapter } = await import("@chat-adapter/discord"));
      ({ createMemoryState } = await import("@chat-adapter/state-memory"));
    } catch (err) {
      console.error(`relay: channel entity '${name}' needs the chat SDK deps: ${err.message}`);
      return;
    }
    const { token, publicKey, appId } = entityCreds(entity);
    if (!token) {
      console.error(`relay: channel entity '${name}': no bot token in $${entity.tokenEnv}`);
      return;
    }
    if (!publicKey) {
      console.error(`relay: channel entity '${name}': no public key in $${entity.publicKeyEnv || "DISCORD_PUBLIC_KEY"} (dev portal -> General Information)`);
      return;
    }
    if (!appId) {
      console.error(`relay: channel entity '${name}': no application id in $${entity.appIdEnv || "DISCORD_APPLICATION_ID"} (dev portal -> General Information)`);
      return;
    }
    // the adapter auto-detects DISCORD_* env; set explicitly AND via env so
    // config-indirected token vars (tokenEnv) work either way
    if (!process.env.DISCORD_BOT_TOKEN) process.env.DISCORD_BOT_TOKEN = token;
    let adapter, bot;
    try {
      adapter = createDiscordAdapter({ botToken: token, publicKey, applicationId: appId });
      bot = new Chat({
        userName: entity.userName || "pty-relay",
        adapters: { discord: adapter },
        state: createMemoryState(),
        logger: "error",
      });
    } catch (err) {
      console.error(`relay: channel entity '${name}' failed to construct: ${err.message}`);
      return;
    }
    const handle = async (thread, message, firstMention) => {
      try {
        if (firstMention) { try { await thread.subscribe(); } catch {} }
        // strip the bot mention token; the @daemon:session grammar is ours
        const text = String(message?.text || "").replace(/<@!?\d+>\s*/g, "").trim();
        const reply = (t) => channelPost(thread, t);
        await this.onInbound(entity, `${name}:${thread.id}`, text, reply, thread);
      } catch {}
    };
    bot.onNewMention((thread, message) => handle(thread, message, true));
    bot.onSubscribedMessage((thread, message) => handle(thread, message, false));
    try { await bot.initialize?.(); } catch (err) {
      console.error(`relay: channel entity '${name}' initialize failed: ${err.message}`);
    }
    this.channels.set(name, { bot, adapter });
    // hold the gateway websocket in ~1h chunks for the router's lifetime
    (async () => {
      while (this.running) {
        try {
          const jobs = [];
          await adapter.startGatewayListener(
            { waitUntil: (p) => jobs.push(Promise.resolve(p).catch(() => {})) },
            3600000);
          await Promise.all(jobs);
        } catch (err) {
          console.error(`relay: channel entity '${name}' gateway error: ${err.message}`);
          await sleep(5000);
        }
      }
    })();
  }

  async start() {
    this.running = true;
    // periodic discovery == auto-enroll of new daemons and sessions
    (async () => {
      while (this.running) {
        try { await this.discover(); } catch {}
        await sleep(4000);
      }
    })();
    // one transport per entity: assistant = hand-rolled telegram long-poll,
    // channel = chat SDK gateway. Two assistant entities on one bot token
    // would double-poll and trade telegram 409s — refuse the duplicate.
    const tokens = new Map();
    for (const [name, raw] of Object.entries(this.config.entities || {})) {
      // config entities are keyed by name but don't carry it; onInbound's
      // enrollment gate compares against entity.name, so stamp it here
      const entity = { ...raw, name };
      if ((entity.mode || "assistant") === "channel") {
        this.startChannelEntity(name, entity).catch((err) =>
          console.error(`relay: channel entity '${name}': ${err.message}`));
        continue;
      }
      const { token } = entityCreds(entity);
      if (token && tokens.has(token)) {
        console.error(`relay: entity '${name}' shares a bot token with '${tokens.get(token)}' — not polling it`);
        continue;
      }
      if (token) tokens.set(token, name);
      this.pollEntity(name, entity);
    }
  }

  stop() {
    this.running = false;
    for (const [, ch] of this.channels) {
      try { ch.bot?.shutdown?.(); } catch {}
    }
  }

  statusPayload() {
    const registry = {};
    for (const [d, info] of this.registry) {
      registry[d] = {
        entity: info.entity?.name || null,
        sessions: [...info.sessions.entries()].map(([n, s]) => ({
          session: n, tier: s.tier, alive: s.alive, cmd: s.cmd,
          hook: this.hookCapable.has(addr(d, n)),
        })),
      };
    }
    return {
      ok: true,
      pid: process.pid,
      sock: RELAY_SOCK,
      uptimeMs: Date.now() - this.startedAt,
      entities: Object.fromEntries(
        Object.entries(this.config.entities || {}).map(([n, e]) => {
          const { token, chatId, publicKey, appId } = entityCreds(e);
          const credsPresent = e.mode === "channel"
            ? Boolean(token && publicKey && appId) // discord needs all three
            : Boolean(token && chatId);
          return [n, { platform: e.platform, mode: e.mode, credsPresent }];
        })
      ),
      enrollments: Object.fromEntries(
        [...new Set([
          ...Object.keys(this.config.daemons || {}),
          ...Object.keys(this.config.enrollments || {}),
        ])].map((d) => [d, daemonConfig(this.config, d).entity]).filter(([, e]) => e)
      ),
      // configured workspaces and their hot/cold state (fs checks, cheap)
      workspaces: Object.fromEntries(
        Object.entries(this.config.daemons || {})
          .filter(([, d]) => d.workspace)
          .map(([name, d]) => {
            const state = workspaceReady(d.workspace);
            return [name, {
              dir: d.workspace.dir,
              repo: d.workspace.repo || null,
              ready: state.ready,
              failed: state.failed || null,
              agent: d.agent?.kind || d.agent?.command || null,
            }];
          })
      ),
      channels: [...this.channels.keys()],
      registry,
      focus: Object.fromEntries(
        [...this.lastTarget.entries()].map(([chat, t]) => [chat, addr(t.daemon, t.session)])
      ),
      recentTurns: this.recentTurns.slice(-20),
    };
  }
}

// ── relay-router process ───────────────────────────────────────────────
// A dedicated daemon: a socket server (hooks post relay-turn here, the CLI
// asks for status, agents post relay-send) plus the RelayRouter loops. It
// answers the core `status`/`shutdown` commands so `p daemons` lists it and
// `p stop all` stops it without knowing it's special.
export async function startRelayRouter() {
  ensureHome();

  // another live router already owns the socket? bail instead of stealing it.
  if (existsSync(RELAY_SOCK)) {
    if (await relayRouterAlive()) {
      // `already`: nothing was started — the parent must not report our pid
      if (process.send) process.send({ ready: true, already: true });
      else console.log("relay-router already running at", RELAY_SOCK);
      process.exit(0);
    }
    try { unlinkSync(RELAY_SOCK); } catch {} // stale socket
  }

  const router = new RelayRouter(loadRelayConfig());
  const MAX_BUF = 1024 * 1024;

  const server = createServer((conn) => {
    let buf = "";
    conn.on("error", () => {});
    conn.setTimeout(30000, () => conn.destroy());
    conn.on("data", async (data) => {
      buf += data.toString();
      if (buf.length > MAX_BUF) {
        try { conn.write(JSON.stringify({ ok: false, error: "request too large" }) + "\n"); } catch {}
        conn.destroy();
        return;
      }
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        let res;
        try { res = await handleRelayCommand(router, req); }
        catch (err) { res = { ok: false, error: err.message }; }
        try { conn.write(JSON.stringify(res) + "\n"); } catch {}
      }
    });
  });

  // a listen failure (path over the ~104-byte unix-socket limit, perms, dir
  // missing) must be one clear line, not an uncaught stack
  server.on("error", (err) => {
    console.error(`relay-router: cannot listen at ${RELAY_SOCK}: ${err.message}`);
    process.exit(1);
  });
  server.listen(RELAY_SOCK, () => {
    try { chmodSync(RELAY_SOCK, 0o600); } catch {}
    if (process.send) process.send({ ready: true });
    else console.log("relay-router listening at", RELAY_SOCK);
  });

  await router.start();

  const shutdown = () => {
    router.stop();
    try { unlinkSync(RELAY_SOCK); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function formatUptimeShort(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

async function handleRelayCommand(router, req) {
  switch (req.cmd) {
    case "relay-turn": {
      // posted by a tier-1 session's hook: the agent finished a turn
      const { daemon, session, message } = req.args || {};
      if (!daemon || !session) return { ok: false, error: "daemon and session required" };
      await router.relayTurn(daemon, session, message || "");
      return { ok: true };
    }
    case "relay-send": {
      // agent->agent (or CLI) injection through the bus
      const { to, text } = req.args || {};
      const target = parseAddress(String(to || ""));
      if (!target) return { ok: false, error: "to must be @daemon:session" };
      if (!text) return { ok: false, error: "text required" };
      return router.deliver({ daemon: target.daemon, session: target.session }, text);
    }
    case "relay-status":
      return router.statusPayload();
    // core-protocol compatibility: `p daemons` probes status, `p stop all`
    // sends shutdown — answer both so the router behaves like a good daemon
    case "status":
      return {
        ok: true,
        status: {
          name: ROUTER_NAME,
          pid: process.pid,
          socket: RELAY_SOCK,
          cwd: process.cwd(),
          startedAt: new Date(router.startedAt).toISOString(),
          uptimeMs: Date.now() - router.startedAt,
          uptime: formatUptimeShort(Date.now() - router.startedAt),
          sessions: { total: 0, alive: 0, dead: 0 },
          config: {},
        },
      };
    case "shutdown": {
      setTimeout(() => {
        router.stop();
        try { unlinkSync(RELAY_SOCK); } catch {}
        process.exit(0);
      }, 50);
      return { ok: true, stopped: ROUTER_NAME, pid: process.pid };
    }
    case "ping":
      return { ok: true };
    default:
      return { ok: false, error: `unknown relay command: ${req.cmd}` };
  }
}

// minimal socket client for the router (the core client's error message names
// the pty daemon; this one names the router)
function relayRequest(req) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(RELAY_SOCK);
    let buf = "", settled = false;
    const settle = (fn, v) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch {}
      fn(v);
    };
    conn.on("error", (e) => settle(reject,
      (e.code === "ENOENT" || e.code === "ECONNREFUSED")
        ? new Error("relay-router not running (p relay start)") : e));
    conn.on("connect", () => {
      try { conn.write(JSON.stringify(req) + "\n"); } catch (e) { settle(reject, e); }
    });
    conn.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      try { settle(resolve, JSON.parse(buf.slice(0, nl))); } catch (e) { settle(reject, e); }
    });
    conn.on("end", () => settle(reject, new Error("relay-router closed connection")));
  });
}

async function relayRouterAlive() {
  try { const r = await relayRequest({ cmd: "ping" }); return !!r?.ok; }
  catch { return false; }
}

// re-exec ourselves as a detached router child — the exact fork pattern the
// core daemon uses (works for `bun <script>` and the compiled binary alike)
export async function ensureRelayRouter() {
  if (await relayRouterAlive()) return { started: false, running: true };
  const base = process.argv[1] && !process.argv[1].startsWith("/$bunfs/")
    ? [process.argv[1]] : [];
  const child = spawnChild(process.execPath, [...base, "relay", "__router"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, __PTY_RELAY_CHILD: "1" },
  });
  return await new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try { child.unref(); child.disconnect(); } catch {}
      resolve(r);
    };
    child.on("message", (m) => {
      if (m?.ready) finish(m.already ? { started: false, running: true } : { started: true, pid: child.pid });
    });
    child.on("error", (err) => finish({ started: false, error: err.message }));
    setTimeout(() => finish({ started: true, pid: child.pid, unconfirmed: true }), 3000);
  });
}

// called by the core on daemon boot: if the relay is configured and this
// daemon is enrolled, make sure a router is up. All checks live here so the
// core's integration stays one line.
export async function maybeAutoStartRelay(daemonName) {
  if (!relayConfigured()) return;
  const cfg = loadRelayConfig();
  if (!cfg.enrollments?.[daemonName]) return;
  await ensureRelayRouter();
}

// ── the hook (tier-1 reach-out) ────────────────────────────────────────
// Installed into the agent CLI; fires when the agent finishes a turn. Two
// real-world payload shapes, and they arrive differently:
//   claude  Stop hook, JSON on STDIN:
//           { session_id, transcript_path, hook_event_name: "Stop", ... }
//           — the final message is NOT inlined; it must be read from
//           transcript_path with the claude adapter.
//   codex   notify program, JSON as the LAST ARGV:
//           { "type": "agent-turn-complete", "last-assistant-message": ... }
//           — the final message IS inlined.
// If neither shape is present we do nothing: guessing (e.g. "newest
// transcript in this cwd") can relay ANOTHER session's message when several
// agents share a project, and a wrong relay is worse than a missed one.
// The hook must never crash or block the CLI: best-effort, always exit 0.
function readStdinAll() {
  if (process.stdin.isTTY) return ""; // run by hand: don't block on a TTY read
  const chunks = [];
  const b = Buffer.alloc(65536);
  try {
    let n;
    while ((n = readSync(0, b, 0, b.length)) > 0) chunks.push(Buffer.from(b.subarray(0, n)));
  } catch {}
  return Buffer.concat(chunks).toString("utf8");
}

function expandHomePath(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export async function runHook(argvTail = []) {
  const session = process.env.PTY_MGR_SESSION;
  const daemon = process.env.PTY_MGR_DAEMON || process.env.PTY_DAEMON || "default";
  if (!session) return; // not inside a managed session: nothing to relay

  // codex: JSON payload rides argv
  let payload = null;
  for (const arg of argvTail) {
    if (typeof arg === "string" && arg.trim().startsWith("{")) {
      try { payload = JSON.parse(arg); break; } catch {}
    }
  }
  // claude: JSON payload rides stdin
  if (!payload) {
    try { payload = JSON.parse(readStdinAll() || "null"); } catch {}
  }
  if (!payload || typeof payload !== "object") return;

  let message = "";
  // codex inlines the turn-final text
  message = payload["last-assistant-message"] || payload.last_assistant_message || "";
  // claude hands the transcript path; parse it with the shipped adapter
  if (!message && payload.transcript_path) {
    try {
      const file = expandHomePath(String(payload.transcript_path));
      if (existsSync(file)) {
        const config = resolveMergedConfig({ cwd: payload.cwd || process.cwd() });
        message = extractLastAssistantMessage(file, "claude", "", config)?.text || "";
      }
    } catch {}
  }
  if (!message) return;

  // agent<->agent links (`p link a b`) live in the pty daemon, not the router:
  // linking works with no relay config and no chat entity at all. The daemon
  // answers as soon as it has queued the hop, so this costs the CLI's turn a
  // socket round-trip, not the delivery.
  try {
    const sock = listDaemonSockets().find((d) => d.name === daemon)?.sockFile;
    if (sock) await sendCommandTo(sock, { cmd: "turn", name: session, args: { message } });
  } catch {} // daemon gone or no link: drop, never block the CLI's turn

  try {
    await relayRequest({ cmd: "relay-turn", args: { daemon, session, message } });
  } catch {} // router down: drop, never block the CLI's turn
}

// ── hook installer ─────────────────────────────────────────────────────
// claude: merge a Stop hook into ~/.claude/settings.json (backed up once to
// settings.json.pty-mgr.bak before the first edit). codex: its notify setting
// lives in TOML — print the exact line instead of regex-editing a format we
// don't parse.
const HOOK_MARK = "relay hook";

function hookCommand() {
  const exe = process.execPath;
  const script = process.argv[1] && !process.argv[1].startsWith("/$bunfs/")
    ? resolvePath(process.argv[1]) : null;
  return script ? `"${exe}" "${script}" relay hook` : `"${exe}" relay hook`;
}

function claudeSettingsPath() {
  return join(homedir(), ".claude", "settings.json");
}

export function installClaudeHook() {
  const path = claudeSettingsPath();
  let settings = {};
  if (existsSync(path)) {
    try { settings = JSON.parse(readFileSync(path, "utf8")); }
    catch { return { ok: false, error: `${path} is not valid JSON — fix it first, not overwriting` }; }
  }
  settings.hooks = settings.hooks || {};
  const stop = (settings.hooks.Stop = settings.hooks.Stop || []);
  const installed = stop.some((g) => (g.hooks || []).some(
    (h) => h.type === "command" && String(h.command || "").includes(HOOK_MARK)));
  if (installed) return { ok: true, path, changed: false };
  const bak = path + ".pty-mgr.bak";
  if (existsSync(path) && !existsSync(bak)) { try { copyFileSync(path, bak); } catch {} }
  stop.push({ hooks: [{ type: "command", command: hookCommand() }] });
  mkdirSync(join(homedir(), ".claude"), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return { ok: true, path, changed: true, command: hookCommand() };
}

export function uninstallClaudeHook() {
  const path = claudeSettingsPath();
  if (!existsSync(path)) return { ok: true, path, changed: false };
  let settings;
  try { settings = JSON.parse(readFileSync(path, "utf8")); }
  catch { return { ok: false, error: `${path} is not valid JSON` }; }
  const stop = settings.hooks?.Stop;
  if (!Array.isArray(stop)) return { ok: true, path, changed: false };
  let changed = false;
  settings.hooks.Stop = stop
    .map((g) => {
      const kept = (g.hooks || []).filter(
        (h) => !(h.type === "command" && String(h.command || "").includes(HOOK_MARK)));
      if (kept.length !== (g.hooks || []).length) changed = true;
      return { ...g, hooks: kept };
    })
    .filter((g) => (g.hooks || []).length > 0);
  if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
  if (changed) writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return { ok: true, path, changed };
}

// ── CLI: p relay <subcommand> ──────────────────────────────────────────
// tiny blocking prompt, same pattern as the core's ask(). STDIN_EOF flips
// when input runs dry (piped/scripted use) so menu loops terminate instead
// of spinning on empty reads.
let STDIN_EOF = false;
function askLine(q) {
  process.stdout.write(q);
  const b = Buffer.alloc(1);
  let line = "";
  let got = false;
  while (true) {
    let n;
    try { n = readSync(0, b, 0, 1); } catch { STDIN_EOF = !got; break; }
    if (!n) { STDIN_EOF = !got; break; }
    got = true;
    const ch = b.toString("utf8");
    if (ch === "\n") break;
    line += ch;
  }
  return line.trim();
}

// ── setup wizard: guided screens over the same config file ─────────────
// Plain ANSI, no TUI dep — bold headers, dim hints, live ✓/✗ env checks.
// Colors only on a TTY so piped/scripted runs stay clean text.
const isTTY = () => Boolean(process.stdout.isTTY);
const paint = (code, s) => (isTTY() ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => paint("1", s);
const dim = (s) => paint("2", s);
const green = (s) => paint("32", s);
const red = (s) => paint("31", s);
const cyan = (s) => paint("36", s);
const clearScreen = () => { if (isTTY()) process.stdout.write("\x1b[2J\x1b[H"); };
const envMark = (name) => (process.env[name] ? green(`✓ $${name}`) : red(`✗ $${name} not set`));

function askDefault(q, def) {
  const hasDef = def !== undefined && def !== "";
  const a = askLine(`  ${q}${hasDef ? dim(` [${def}]`) : ""}: `);
  // "y"/"yes" at a value prompt is someone accepting the shown default,
  // never a literal value — without this, "working folder [~/work/x]: y"
  // stores dir="y"
  if (hasDef && /^(y|yes)$/i.test(a)) return def;
  return a || def || "";
}

function askYesNo(q, def = true) {
  const a = askLine(`  ${q} ${dim(def ? "[Y/n]" : "[y/N]")}: `).toLowerCase();
  if (!a) return def;
  return a === "y" || a === "yes";
}

// numbered menu; returns the chosen option's key, or null on quit/EOF
function askChoice(title, options) {
  console.log(`  ${title}`);
  for (let i = 0; i < options.length; i++) {
    console.log(`    ${cyan(String(i + 1))}. ${options[i].label}`);
  }
  while (!STDIN_EOF) {
    const a = askLine(`  ${dim("choose (or q to go back)")}: `);
    if (STDIN_EOF || a === "q" || a === "") return null;
    const n = parseInt(a, 10);
    if (n >= 1 && n <= options.length) return options[n - 1].key;
  }
  return null;
}

function claudeHookInstalled() {
  try {
    const settings = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
    return (settings.hooks?.Stop || []).some((g) => (g.hooks || []).some(
      (h) => h.type === "command" && String(h.command || "").includes(HOOK_MARK)));
  } catch { return false; }
}

function entityEnvVars(e) {
  if ((e.mode || "assistant") === "channel") {
    return [e.tokenEnv, e.publicKeyEnv || "DISCORD_PUBLIC_KEY", e.appIdEnv || "DISCORD_APPLICATION_ID"];
  }
  return [e.tokenEnv, e.chatEnv].filter(Boolean);
}

async function wizardOverview() {
  const cfg = loadRelayConfig();
  clearScreen();
  console.log(bold("pty-mgr relay setup"));
  console.log(dim(`  config: ${RELAY_CONFIG}`));
  console.log();

  const entities = Object.entries(cfg.entities || {});
  console.log(bold("  bots"));
  if (!entities.length) console.log(dim("    (none yet — add one)"));
  for (const [name, e] of entities) {
    console.log(`    ${name}  ${e.platform}/${e.mode}  ${entityEnvVars(e).map(envMark).join("  ")}`);
  }
  console.log();

  const daemonNames = [...new Set([
    ...Object.keys(cfg.daemons || {}),
    ...Object.keys(cfg.enrollments || {}),
  ])];
  console.log(bold("  daemons"));
  if (!daemonNames.length) console.log(dim("    (none enrolled — enroll one)"));
  for (const name of daemonNames) {
    const d = daemonConfig(cfg, name);
    let line = `    @${name}  -> ${d.entity || dim("(no bot)")}`;
    if (d.workspace) {
      const state = workspaceReady(d.workspace);
      line += `  ${d.workspace.dir}  ${state.ready ? green("hot") : red(`cold (${state.failed})`)}`;
    }
    if (d.agent) line += dim(`  agent=${d.agent.kind || d.agent.command}`);
    console.log(line);
  }
  console.log();

  const hookOn = claudeHookInstalled();
  const routerOn = await relayRouterAlive();
  console.log(`  ${bold("claude hook")}  ${hookOn ? green("✓ installed") : red("✗ not installed")}     ${bold("router")}  ${routerOn ? green("✓ running") : red("✗ not running")}`);
  console.log();

  return askChoice(bold("what next?"), [
    { key: "entity", label: "add / edit a bot (telegram or discord)" },
    { key: "daemon", label: "enroll a daemon + workspace (cold-start)" },
    { key: "hook", label: hookOn ? "remove the claude turn hook" : "install the claude turn hook" },
    { key: "start", label: routerOn ? "router status" : "start the router" },
    { key: "quit", label: "done" },
  ]);
}

function wizardEntity() {
  const cfg = loadRelayConfig();
  clearScreen();
  console.log(bold("add / edit a bot"));
  console.log();
  const platform = askChoice("platform", [
    { key: "telegram", label: `telegram  ${dim("assistant: 1:1 DM with you")}` },
    { key: "discord", label: `discord   ${dim("channel: shared room, threads, mention to address")}` },
  ]);
  if (!platform) return;
  const mode = platform === "discord" ? "channel" : "assistant";
  const name = askDefault("name for this bot", platform);
  const entity = { platform, mode };
  entity.tokenEnv = askDefault("env var holding the bot token",
    platform === "discord" ? "DISCORD_BOT_TOKEN" : "TELEGRAM_BOT_TOKEN");
  if (mode === "assistant") {
    entity.chatEnv = askDefault("env var holding your chat id", "TELEGRAM_CHAT_ID");
  } else {
    entity.publicKeyEnv = askDefault("env var holding the public key", "DISCORD_PUBLIC_KEY");
    entity.appIdEnv = askDefault("env var holding the application id", "DISCORD_APPLICATION_ID");
    entity.userName = askDefault("bot username in the channel", "pty-relay");
  }
  cfg.entities[name] = entity;
  saveRelayConfig(cfg);
  console.log();
  console.log(`  ${green("saved")} '${name}' (${platform}/${mode})`);
  const missing = entityEnvVars(entity).filter((v) => !process.env[v]);
  if (missing.length) {
    console.log(`  ${red("missing env:")} export these before the router starts:`);
    for (const v of missing) console.log(`    export ${v}=...`);
    if (platform === "discord") console.log(dim("    (all three live in the discord dev portal -> General Information)"));
  }
  askLine(dim("\n  enter to continue "));
}

function wizardDaemon() {
  const cfg = loadRelayConfig();
  clearScreen();
  console.log(bold("enroll a daemon + workspace"));
  console.log(dim("  a daemon is an isolated session group (p @name daemon). enrolling puts"));
  console.log(dim("  it on a bot; a workspace makes cold @name:session messages self-provision."));
  console.log();
  const entityNames = Object.keys(cfg.entities || {});
  if (!entityNames.length) {
    console.log(red("  no bots configured yet — add a bot first"));
    askLine(dim("\n  enter to continue "));
    return;
  }
  const daemon = askDefault("daemon name (without @)", "");
  if (!daemon) return;
  const entity = entityNames.length === 1
    ? entityNames[0]
    : askChoice("which bot bridges it?", entityNames.map((n) => ({ key: n, label: n })));
  if (!entity) return;

  cfg.daemons = cfg.daemons || {};
  const d = { ...(cfg.daemons[daemon] || {}), entity };
  if (cfg.enrollments?.[daemon]) delete cfg.enrollments[daemon];

  if (askYesNo("configure a workspace (cold-start provisioning)?", Boolean(d.workspace))) {
    const ws = d.workspace || {};
    ws.dir = askDefault("working folder", ws.dir || `~/work/${daemon}`);
    const repo = askDefault("git repo to clone there (empty = just use the folder)", ws.repo || "");
    if (repo) ws.repo = repo; else delete ws.repo;
    if (repo) {
      const branch = askDefault("branch", ws.branch || "");
      if (branch) ws.branch = branch; else delete ws.branch;
    }
    const setup = askDefault("setup commands, comma-separated (e.g. bun install)",
      (ws.setup || []).join(", "));
    if (setup) ws.setup = setup.split(",").map((s) => s.trim()).filter(Boolean);
    else delete ws.setup;
    d.workspace = ws;
    console.log(dim("  ready-checks default to dir-exists (+ git-repo when a repo is set);"));
    console.log(dim(`  add custom ones under daemons.${daemon}.workspace.ready in ${RELAY_CONFIG}`));
  }

  const agentKind = askChoice("agent a cold session runs", [
    { key: "claude", label: "claude" },
    { key: "codex", label: "codex" },
    { key: "custom", label: "custom command" },
    { key: "none", label: `none ${dim("(sessions must already exist)")}` },
  ]);
  if (agentKind === "custom") {
    const command = askDefault("command", d.agent?.command || "zsh");
    const argsStr = askDefault("args (space-separated)", (d.agent?.args || []).join(" "));
    d.agent = { command, args: argsStr ? argsStr.split(/\s+/) : [] };
  } else if (agentKind === "claude" || agentKind === "codex") {
    d.agent = { kind: agentKind };
  } else if (agentKind === "none") {
    delete d.agent;
  }

  cfg.daemons[daemon] = d;
  saveRelayConfig(cfg);
  console.log();
  console.log(`  ${green("saved")} @${daemon} -> ${entity}${d.workspace ? `  workspace=${d.workspace.dir}` : ""}`);
  askLine(dim("\n  enter to continue "));
}

function wizardHook() {
  clearScreen();
  console.log(bold("claude turn hook"));
  console.log(dim("  fires at every claude turn-end inside a managed session and relays the"));
  console.log(dim("  final message to your chat. install once; agents never know it exists."));
  console.log();
  if (claudeHookInstalled()) {
    if (askYesNo("hook is installed — remove it?", false)) {
      const r = uninstallClaudeHook();
      console.log(r.ok ? `  ${green("removed")} (${r.path})` : `  ${red("error:")} ${r.error}`);
    }
  } else if (askYesNo(`install into ${claudeSettingsPath()}?`, true)) {
    const r = installClaudeHook();
    if (r.ok) {
      console.log(`  ${green("installed")}  command: ${r.command || "(already present)"}`);
      console.log(dim("  codex: add to ~/.codex/config.toml:"));
      console.log(dim(`    notify = [${hookCommand().match(/"[^"]+"|\S+/g).map((t) => JSON.stringify(t.replace(/^"|"$/g, ""))).join(", ")}]`));
    } else {
      console.log(`  ${red("error:")} ${r.error}`);
    }
  }
  askLine(dim("\n  enter to continue "));
}

async function wizardStart() {
  clearScreen();
  console.log(bold("router"));
  console.log();
  if (await relayRouterAlive()) {
    try { printStatus(await relayRequest({ cmd: "relay-status" })); } catch {}
  } else if (askYesNo("router is not running — start it now?", true)) {
    const r = await ensureRelayRouter();
    if (r.running) console.log(`  ${green("already running")}`);
    else if (r.started) console.log(`  ${green("started")}${r.pid ? `  pid=${r.pid}` : ""}`);
    else console.log(`  ${red("failed to start")}${r.error ? `: ${r.error}` : ""}`);
    await sleep(800);
    try { printStatus(await relayRequest({ cmd: "relay-status" })); } catch {}
  }
  askLine(dim("\n  enter to continue "));
}

async function runSetupWizard() {
  initRelayConfig();
  while (!STDIN_EOF) {
    const pick = await wizardOverview();
    if (!pick || pick === "quit") break;
    if (pick === "entity") wizardEntity();
    else if (pick === "daemon") wizardDaemon();
    else if (pick === "hook") wizardHook();
    else if (pick === "start") await wizardStart();
  }
  clearScreen();
  const cfg = loadRelayConfig();
  const missing = Object.values(cfg.entities || {}).flatMap(entityEnvVars).filter((v) => !process.env[v]);
  console.log(bold("relay setup done"));
  console.log(`  config: ${RELAY_CONFIG}`);
  if (missing.length) console.log(`  ${red("still missing env:")} ${[...new Set(missing)].join(", ")}`);
  if (!(await relayRouterAlive())) console.log(`  start when ready: ${cyan("p relay start")}`);
}

function printStatus(s) {
  console.log(`relay-router  pid=${s.pid}  up=${formatUptimeShort(s.uptimeMs)}`);
  console.log(`  socket: ${s.sock}`);
  const entities = Object.entries(s.entities || {});
  console.log(entities.length ? "  entities:" : "  entities: (none — p relay setup)");
  for (const [name, e] of entities) {
    console.log(`    ${name}  ${e.platform}/${e.mode}  creds=${e.credsPresent ? "present" : "MISSING"}`);
  }
  const daemons = Object.entries(s.registry || {});
  console.log(daemons.length ? "  daemons:" : "  daemons: (none discovered)");
  for (const [name, d] of daemons) {
    console.log(`    @${name}${d.entity ? `  -> ${d.entity}` : "  (not enrolled)"}`);
    for (const sess of d.sessions) {
      console.log(`      ${addr(name, sess.session)}  tier-${sess.tier}${sess.hook ? " (hook)" : ""}  ${sess.alive ? "alive" : "dead"}  ${sess.cmd}`);
    }
  }
  const workspaces = Object.entries(s.workspaces || {});
  if (workspaces.length) {
    console.log("  workspaces:");
    for (const [name, w] of workspaces) {
      console.log(`    @${name}  ${w.dir}  ${w.ready ? "hot" : `cold (${w.failed})`}${w.agent ? `  agent=${w.agent}` : ""}`);
    }
  }
  if ((s.channels || []).length) console.log(`  channels: ${s.channels.join(", ")}`);
  const focus = Object.entries(s.focus || {});
  if (focus.length) {
    console.log("  focus:");
    for (const [chat, target] of focus) console.log(`    chat ${chat} -> ${target}`);
  }
  const turns = (s.recentTurns || []).slice(-5);
  if (turns.length) {
    console.log("  recent turns:");
    for (const t of turns) {
      console.log(`    ${t.at}  ${addr(t.daemon, t.session)}  ${t.delivered ? "sent" : "dropped"}  ${t.preview}`);
    }
  }
}

const RELAY_USAGE = [
  "usage:",
  "  p relay setup                      guided setup screens (bots, daemons, hook, start)",
  "  p relay init                       create the relay config",
  "  p relay enroll <daemon> <entity>   put a daemon on an entity's bus (scriptable)",
  "  p relay start                      spin up the relay-router daemon",
  "  p relay stop                       stop the relay-router",
  "  p relay status                     entities, daemons, sessions, recent turns",
  "  p relay send @daemon:session <text>  inject through the bus (agents use this too)",
  "  p relay hook install|uninstall     wire the claude Stop hook (codex: prints config)",
  `config: ${RELAY_CONFIG}`,
].join("\n");

export async function runRelayCommand(args) {
  const sub = args[0];
  switch (sub) {
    case "init": {
      const r = initRelayConfig();
      console.log(r.created ? `created ${r.path}` : `exists  ${r.path}`);
      return;
    }
    case "setup": {
      // guided screens: overview -> bots -> daemons/workspaces -> hook -> start
      await runSetupWizard();
      return;
    }
    case "enroll": {
      const daemon = args[1], entity = args[2];
      if (!daemon || !entity) {
        console.error("usage: p relay enroll <daemon> <entity>");
        process.exit(1);
      }
      const cfg = loadRelayConfig();
      if (!cfg.entities[entity]) {
        console.error(`no such entity: ${entity} (run: p relay setup)`);
        process.exit(1);
      }
      // write the daemons form; migrate any legacy enrollments entry
      cfg.daemons = cfg.daemons || {};
      cfg.daemons[daemon] = { ...(cfg.daemons[daemon] || {}), entity };
      if (cfg.enrollments?.[daemon]) delete cfg.enrollments[daemon];
      console.log(`enrolled @${daemon} -> ${entity}  (${saveRelayConfig(cfg)})`);
      console.log(`workspace/agent cold-start is configured per daemon in that file (daemons.${daemon}.workspace)`);
      return;
    }
    case "start": {
      const r = await ensureRelayRouter();
      if (r.running) console.log("relay-router already running");
      else if (r.started) console.log(`relay-router started${r.pid ? `  pid=${r.pid}` : ""}${r.unconfirmed ? "  (unconfirmed — check p relay status)" : ""}`);
      else console.error(`failed to start relay-router${r.error ? `: ${r.error}` : ""}`);
      return;
    }
    case "stop": {
      try {
        const r = await relayRequest({ cmd: "shutdown" });
        console.log(r.ok ? `stopped: ${r.stopped}` : `error: ${r.error}`);
      } catch (e) { console.log(`relay-router not running (${e.message})`); }
      return;
    }
    case "status": {
      try { printStatus(await relayRequest({ cmd: "relay-status" })); }
      catch (e) { console.log(`relay-router: not running (${e.message})`); }
      return;
    }
    case "send": {
      const to = args[1];
      const text = args.slice(2).join(" ");
      if (!parseAddress(to || "") || !text) {
        console.error("usage: p relay send @daemon:session <text>");
        process.exit(1);
      }
      try {
        const r = await relayRequest({ cmd: "relay-send", args: { to, text } });
        if (!r.ok) { console.error(`error: ${r.error}`); process.exit(1); }
        console.log("delivered");
      } catch (e) { console.error(e.message); process.exit(1); }
      return;
    }
    case "hook": {
      const action = args[1];
      if (action === "install") {
        const r = installClaudeHook();
        if (!r.ok) { console.error(`error: ${r.error}`); process.exit(1); }
        console.log(r.changed
          ? `claude Stop hook installed in ${r.path}\n  command: ${r.command}`
          : `claude Stop hook already installed (${r.path})`);
        console.log("codex: add to ~/.codex/config.toml:");
        console.log(`  notify = [${hookCommand().match(/"[^"]+"|\S+/g).map((t) => JSON.stringify(t.replace(/^"|"$/g, ""))).join(", ")}]`);
        return;
      }
      if (action === "uninstall") {
        const r = uninstallClaudeHook();
        if (!r.ok) { console.error(`error: ${r.error}`); process.exit(1); }
        console.log(r.changed ? `claude Stop hook removed from ${r.path}` : "claude Stop hook was not installed");
        return;
      }
      // no action: we ARE the hook (invoked by the CLI at end of turn)
      await runHook(args.slice(1));
      return;
    }
    case "__router": // internal: the forked router child
      await startRelayRouter();
      return;
    default:
      console.log(RELAY_USAGE);
  }
}

// standalone entry: `bun lib/msg-relay.mjs <sub...>` works without the core
// CLI (accepts an optional leading "relay" token so the router re-exec's
// argv shape — [script, "relay", "__router"] — parses the same way).
const _base = process.argv[1] && process.argv[1].split("/").pop();
if (_base === "msg-relay.mjs") {
  const argv = process.argv.slice(2);
  runRelayCommand(argv[0] === "relay" ? argv.slice(1) : argv).catch((err) => {
    console.error("error:", err.message);
    process.exit(1);
  });
}
