#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(DEMO_DIR, '..');
const DEFAULT_CONFIG = join(REPO_ROOT, 'wrap.config');

function expandHome(path) {
  if (!path) return path;
  if (path === '~') return process.env.HOME || path;
  if (path.startsWith('~/')) return join(process.env.HOME || '', path.slice(2));
  return path;
}

export function projectKeyForCwd(cwd) {
  return cwd.replace(/\//g, '-');
}

export function loadConfig(configPath = DEFAULT_CONFIG) {
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

function walkJsonlFiles(root, files = []) {
  root = expandHome(root);
  if (!root || !existsSync(root)) return files;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      walkJsonlFiles(path, files);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(path);
    }
  }
  return files;
}

function timestampMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function getPath(obj, path) {
  if (!path) return obj;
  return String(path).split('.').reduce((value, part) => {
    if (value == null) return undefined;
    return value[part];
  }, obj);
}

function matchesWhere(obj, where = {}) {
  return Object.entries(where).every(([path, expected]) => getPath(obj, path) === expected);
}

function renderTemplate(value, context) {
  return String(value)
    .replaceAll('${home}', process.env.HOME || '')
    .replaceAll('${cwd}', context.cwd)
    .replaceAll('${projectKey}', projectKeyForCwd(context.cwd));
}

function adapterForKind(kind, config) {
  const adapter = config.adapters?.[kind];
  if (adapter) return adapter;

  if (kind === 'codex') {
    const codex = config.logs?.codex || {};
    return {
      roots: [codex.mainTranscripts, codex.archivedTranscripts].filter(Boolean),
      sessionTimestampPaths: ['payload.timestamp', 'timestamp'],
      assistant: {
        where: {
          type: 'response_item',
          'payload.type': 'message',
          'payload.role': 'assistant',
        },
        text: [{ array: 'payload.content', where: { type: 'output_text' }, path: 'text' }],
      },
      stripPatterns: ['\\n*<oai-mem-citation>[\\s\\S]*?</oai-mem-citation>\\s*$'],
    };
  }

  if (kind === 'claude') {
    const root = config.logs?.claudeCode?.projectTranscripts;
    return {
      roots: root ? [join(root, '${projectKey}'), root] : [],
      sessionTimestampPaths: ['timestamp'],
      assistant: {
        where: { type: 'assistant' },
        text: [{ array: 'message.content', where: { type: 'text' }, path: 'text' }],
      },
    };
  }

  throw new Error(`unknown agent kind: ${kind}`);
}

function transcriptStartedAtMs(file, adapter) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const timestampPaths = adapter.sessionTimestampPaths || ['payload.timestamp', 'timestamp'];

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

export function findNewestTranscript({ kind, cwd = process.cwd(), sinceMs = 0, config }) {
  const adapter = adapterForKind(kind, config);
  const roots = transcriptRootsForKind(kind, config, cwd);
  const candidates = roots
    .flatMap((root) => walkJsonlFiles(root))
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
      if (aHasStart && bHasStart) return a.startedMs - b.startedMs;
      if (aHasStart !== bHasStart) return aHasStart ? -1 : 1;
      return b.mtimeMs - a.mtimeMs;
    });

  return candidates[0]?.path || null;
}

function textFromSelector(obj, selector) {
  if (selector.array) {
    const value = getPath(obj, selector.array);
    if (!Array.isArray(value)) return '';
    return value
      .filter((part) => part && typeof part === 'object')
      .filter((part) => matchesWhere(part, selector.where || {}))
      .map((part) => getPath(part, selector.path || 'text'))
      .filter((text) => typeof text === 'string' && text.length > 0)
      .join('\n')
      .trim();
  }

  const value = getPath(obj, selector.path);
  return typeof value === 'string' ? value.trim() : '';
}

function assistantTextFromObject(obj, adapter) {
  const assistant = adapter.assistant || {};
  if (!matchesWhere(obj, assistant.where || {})) return '';

  let text = (assistant.text || [])
    .map((selector) => textFromSelector(obj, selector))
    .filter(Boolean)
    .join('\n')
    .trim();

  for (const pattern of adapter.stripPatterns || []) {
    text = text.replace(new RegExp(pattern, 'm'), '').trim();
  }

  return text;
}

function messageKey(obj, lineNumber) {
  return [
    obj.timestamp,
    obj.uuid,
    obj.payload?.id,
    obj.payload?.call_id,
    lineNumber,
  ].filter(Boolean).join(':');
}

export function extractLastAssistantMessage(file, kind, afterKey = '', config = loadConfig()) {
  const adapter = adapterForKind(kind, config);
  const lines = readFileSync(file, 'utf8').split('\n');

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
    if (afterKey && key <= afterKey) continue;
    return { key, text, file };
  }

  return null;
}

export function writeSessionMeta(metaDir, meta) {
  const file = join(metaDir, `${meta.session}.json`);
  writeFileSync(file, JSON.stringify(meta, null, 2) + '\n');
  return file;
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const args = argv.slice(1);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      options[arg.slice(2)] = args[i + 1];
      i++;
    }
  }

  if (command === 'latest') {
    const config = loadConfig(options.config || DEFAULT_CONFIG);
    const file = findNewestTranscript({
      kind: options.kind,
      cwd: options.cwd || process.cwd(),
      sinceMs: Number(options.sinceMs || 0),
      config,
    });
    printJson({ file });
    return;
  }

  if (command === 'last') {
    const config = loadConfig(options.config || DEFAULT_CONFIG);
    const msg = extractLastAssistantMessage(options.file, options.kind, options.afterKey || '', config);
    printJson(msg || null);
    return;
  }

  if (command === 'send') {
    execFileSync('pty-mgr', ['send', options.to, options.text || ''], { stdio: 'inherit' });
    return;
  }

  process.stderr.write('usage: node demo/log-tail.mjs latest|last|send [options]\n');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
