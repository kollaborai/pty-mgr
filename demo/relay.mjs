#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractLastAssistantMessage,
  findNewestTranscript,
  loadConfig,
} from './log-tail.mjs';

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(DEMO_DIR, '.pagent');
const DEFAULT_CONFIG = resolve(DEMO_DIR, '..', 'wrap.config');

function parseArgs(argv) {
  const options = {
    intervalMs: 1000,
    timeoutMs: 0,
    once: false,
    dryRun: false,
    config: DEFAULT_CONFIG,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--once') options.once = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--from') options.from = argv[++i];
    else if (arg === '--to') options.to = argv[++i];
    else if (arg === '--kind') options.kind = argv[++i];
    else if (arg === '--config') options.config = argv[++i];
    else if (arg === '--interval-ms') options.intervalMs = Number(argv[++i]);
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++i]);
    else if (!options.from) options.from = arg;
    else if (!options.to) options.to = arg;
  }

  if (!options.from || !options.to) {
    throw new Error('usage: prelay <from-session> <to-session> [--once]');
  }

  return options;
}

function readSessionMeta(session, stateDir = STATE_DIR) {
  const file = join(stateDir, 'sessions', `${session}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function relayStateFile(from, to, stateDir = STATE_DIR) {
  const relayDir = join(stateDir, 'relays');
  mkdirSync(relayDir, { recursive: true });
  return join(relayDir, `${from}-to-${to}.json`);
}

function readRelayState(from, to, stateDir = STATE_DIR) {
  const file = relayStateFile(from, to, stateDir);
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeRelayState(from, to, state, stateDir = STATE_DIR) {
  writeFileSync(relayStateFile(from, to, stateDir), JSON.stringify(state, null, 2) + '\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendMessage(target, text, dryRun, sendOverride = null) {
  if (sendOverride) {
    sendOverride(target, text);
    return;
  }
  if (dryRun) {
    process.stdout.write(`[dry-run] pty-mgr send ${target} ${JSON.stringify(text)}\n`);
    return;
  }
  execFileSync('pty-mgr', ['send', target, text], { stdio: 'inherit' });
}

export async function runRelay(options, deps = {}) {
  const stateDir = options.stateDir || STATE_DIR;
  const meta = readSessionMeta(options.from, stateDir);
  const kind = options.kind || meta?.kind;
  if (!kind) throw new Error(`unknown source kind for session: ${options.from}`);

  const config = deps.config || loadConfig(options.config);
  const sinceMs = meta?.startedAtMs || 0;
  const cwd = meta?.cwd || process.cwd();
  const state = readRelayState(options.from, options.to, stateDir);
  const started = Date.now();

  while (true) {
    const logFile = findNewestTranscript({ kind, cwd, sinceMs, config });
    if (logFile) {
      const msg = extractLastAssistantMessage(logFile, kind, state.lastKey || '', config);
      if (msg?.text) {
        sendMessage(options.to, msg.text, options.dryRun, deps.sendMessage);
        writeRelayState(options.from, options.to, {
          lastKey: msg.key,
          lastText: msg.text,
          logFile,
          relayedAt: new Date().toISOString(),
        }, stateDir);
        return { sent: true, logFile, key: msg.key, text: msg.text };
      }
    }

    if (options.once) return { sent: false, logFile: null };
    if (options.timeoutMs && Date.now() - started > options.timeoutMs) {
      return { sent: false, timeout: true };
    }
    await sleep(options.intervalMs);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runRelay(parseArgs(argv));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
