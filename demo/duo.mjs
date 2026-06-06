#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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

const FIRST_REVIEW_PROMPT = 'What should I fix first and how?';
const NEXT_STEP_PROMPT = 'What should we do next?';
const WORKER_INSTRUCTION = [
  'Do the work now.',
  'When finished, report what changed, what you verified, and what remains.',
].join(' ');

function stripRelayFooters(text) {
  return text.replace(/\n*<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>\s*$/m, '').trim();
}

function parseArgs(argv) {
  const options = {
    config: DEFAULT_CONFIG,
    stateDir: STATE_DIR,
    intervalMs: 1000,
    watchInterval: '4s',
    timeoutMs: 0,
    maxCycles: 1,
    dryRun: false,
    resetState: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--reset-state') options.resetState = true;
    else if (arg === '--task') options.task = argv[++i];
    else if (arg === '--config') options.config = argv[++i];
    else if (arg === '--state-dir') options.stateDir = argv[++i];
    else if (arg === '--interval-ms') options.intervalMs = Number(argv[++i]);
    else if (arg === '--watch-interval') options.watchInterval = argv[++i];
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++i]);
    else if (arg === '--max-cycles') options.maxCycles = Number(argv[++i]);
    else if (!options.claudeSession) options.claudeSession = arg;
    else if (!options.codexSession) options.codexSession = arg;
  }

  if (!options.claudeSession || !options.codexSession) {
    throw new Error('usage: pduo <claude-session> <codex-session> [--task "..."]');
  }
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSessionMeta(session, stateDir) {
  const file = join(stateDir, 'sessions', `${session}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function duoStateFile(claudeSession, codexSession, stateDir) {
  const dir = join(stateDir, 'duos');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${claudeSession}-with-${codexSession}.json`);
}

function readDuoState(claudeSession, codexSession, stateDir) {
  const file = duoStateFile(claudeSession, codexSession, stateDir);
  if (!existsSync(file)) return { cycles: 0 };
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function resetDuoState(claudeSession, codexSession, stateDir) {
  const file = duoStateFile(claudeSession, codexSession, stateDir);
  if (existsSync(file)) unlinkSync(file);
}

function writeDuoState(claudeSession, codexSession, stateDir, state) {
  writeFileSync(
    duoStateFile(claudeSession, codexSession, stateDir),
    JSON.stringify(state, null, 2) + '\n'
  );
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

function watchSession(session, interval, watchOverride = null) {
  if (watchOverride) return watchOverride(session, interval);
  return execFileSync('pty-mgr', ['watch', session, interval], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function buildClaudeToCodexMessage(text, completedCycles = 0) {
  const prompt = completedCycles === 0 ? FIRST_REVIEW_PROMPT : NEXT_STEP_PROMPT;
  return `${stripRelayFooters(text)}\n\n${prompt}`;
}

export function buildCodexToClaudeMessage(text) {
  return `${stripRelayFooters(text)}\n\n${WORKER_INSTRUCTION}`;
}

function logFor(meta, config) {
  return findNewestTranscript({
    kind: meta.kind,
    cwd: meta.cwd,
    sinceMs: meta.startedAtMs || 0,
    config,
  });
}

async function waitForMessage({
  meta,
  config,
  afterKey,
  intervalMs,
  timeoutMs,
  watchInterval,
  watchOverride,
}) {
  const started = Date.now();
  while (true) {
    const status = watchSession(meta.session, watchInterval, watchOverride);
    if (status === 'done') {
      const file = logFor(meta, config);
      if (file) {
        const msg = extractLastAssistantMessage(file, meta.kind, afterKey || '', config);
        if (msg?.text) return msg;
      }
    } else if (status !== 'working') {
      throw new Error(`unexpected watch status for ${meta.session}: ${status}`);
    }

    if (timeoutMs && Date.now() - started > timeoutMs) return null;
    await sleep(intervalMs);
  }
}

export async function runDuo(options, deps = {}) {
  const config = deps.config || loadConfig(options.config);
  const claudeMeta = readSessionMeta(options.claudeSession, options.stateDir);
  const codexMeta = readSessionMeta(options.codexSession, options.stateDir);
  if (!claudeMeta) throw new Error(`missing metadata for claude session: ${options.claudeSession}`);
  if (!codexMeta) throw new Error(`missing metadata for codex session: ${options.codexSession}`);
  if (claudeMeta.kind !== 'claude') throw new Error(`${options.claudeSession} is not a claude session`);
  if (codexMeta.kind !== 'codex') throw new Error(`${options.codexSession} is not a codex session`);

  if (options.resetState) {
    resetDuoState(options.claudeSession, options.codexSession, options.stateDir);
  }

  const state = readDuoState(options.claudeSession, options.codexSession, options.stateDir);
  const events = [];

  if (options.task && !state.initialTaskSent) {
    sendMessage(options.claudeSession, options.task, options.dryRun, deps.sendMessage);
    state.initialTaskSent = true;
    state.pending = 'claude';
    events.push({ direction: 'user-to-claude', text: options.task });
    writeDuoState(options.claudeSession, options.codexSession, options.stateDir, state);
  }

  for (let i = 0; i < options.maxCycles; i++) {
    const pendingCodex = state.pending === 'codex' || (state.lastClaudeKey && !state.lastCodexKey);
    if (!pendingCodex) {
      const claudeMsg = await waitForMessage({
        meta: claudeMeta,
        config,
        afterKey: state.lastClaudeKey || '',
        intervalMs: options.intervalMs,
        timeoutMs: options.timeoutMs,
        watchInterval: options.watchInterval,
        watchOverride: deps.watchSession,
      });
      if (!claudeMsg) {
        state.pending = 'claude';
        writeDuoState(options.claudeSession, options.codexSession, options.stateDir, state);
        return { completed: false, waitingFor: 'claude', events };
      }

      const toCodex = buildClaudeToCodexMessage(claudeMsg.text, state.cycles || 0);
      sendMessage(options.codexSession, toCodex, options.dryRun, deps.sendMessage);
      state.lastClaudeKey = claudeMsg.key;
      state.pending = 'codex';
      events.push({ direction: 'claude-to-codex', text: toCodex });
      writeDuoState(options.claudeSession, options.codexSession, options.stateDir, state);
    }

    const codexMsg = await waitForMessage({
      meta: codexMeta,
      config,
      afterKey: state.lastCodexKey || '',
      intervalMs: options.intervalMs,
      timeoutMs: options.timeoutMs,
      watchInterval: options.watchInterval,
      watchOverride: deps.watchSession,
    });
    if (!codexMsg) {
      writeDuoState(options.claudeSession, options.codexSession, options.stateDir, state);
      return { completed: false, waitingFor: 'codex', events };
    }

    const toClaude = buildCodexToClaudeMessage(codexMsg.text);
    sendMessage(options.claudeSession, toClaude, options.dryRun, deps.sendMessage);
    state.lastCodexKey = codexMsg.key;
    state.cycles = (state.cycles || 0) + 1;
    delete state.pending;
    events.push({ direction: 'codex-to-claude', text: toClaude });
    writeDuoState(options.claudeSession, options.codexSession, options.stateDir, state);
  }

  return { completed: true, cycles: state.cycles, events };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runDuo(parseArgs(argv));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
