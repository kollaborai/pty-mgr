import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  extractLastAssistantMessage,
  findNewestTranscript,
  projectKeyForCwd,
} from '../demo/log-tail.mjs';
import {
  buildClaudeToCodexMessage,
  buildCodexToClaudeMessage,
  resetDuoState,
  runDuo,
} from '../demo/duo.mjs';
import { runRelay } from '../demo/relay.mjs';

describe('demo log tailing', () => {
  it('background launchers bypass shell wrapper functions', () => {
    const root = mkdtempSync(join(tmpdir(), 'pagent-launch-'));
    const binDir = join(root, 'bin');
    const logFile = join(root, 'pty-mgr.log');
    mkdirSync(binDir, { recursive: true });
    const fakePtyMgr = join(binDir, 'pty-mgr');
    writeFileSync(fakePtyMgr, `#!/bin/sh
echo "$@" >> "$PAGENT_TEST_LOG"
if [ "$1" = "wrap" ]; then
  echo "demo-session pid=123"
  exit 0
fi
exit 0
`);
    chmodSync(fakePtyMgr, 0o755);

    const r = Bun.spawnSync([
      'zsh',
      '-fc',
      [
        'source demo/pagent.sh',
        `PAGENT_STATE_DIR=${root}/state`,
        'PAGENT_SESSION_DIR=$PAGENT_STATE_DIR/sessions',
        'pclaude_bg >/dev/null',
        'pcodex_bg >/dev/null',
      ].join('; '),
    ], {
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        PAGENT_TEST_LOG: logFile,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(r.exitCode).toBe(0);
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('wrap command claude --dangerously-skip-permissions');
    expect(log).toContain('wrap command codex --yolo');
    expect(log).not.toContain('wrap claude');
    expect(log).not.toContain('wrap codex');
  });

  it('formats the first Claude finding for Codex without naming Codex to Claude', () => {
    const msg = buildClaudeToCodexMessage('I reviewed the codebase and found setup bugs.', 0);
    expect(msg).toContain('I reviewed the codebase and found setup bugs.');
    expect(msg).toContain('What should I fix first and how?');
  });

  it('formats later Claude completion reports as next-action requests', () => {
    const msg = buildClaudeToCodexMessage('I fixed the wrapper parser and tests pass.', 1);
    expect(msg).toContain('I fixed the wrapper parser and tests pass.');
    expect(msg).toContain('What should we do next?');
    expect(msg).not.toContain('What should I fix first and how?');
  });

  it('formats planner direction for Claude as a direct assignment', () => {
    const msg = buildCodexToClaudeMessage('Fix setup wrapper replacement first.');
    expect(msg).toContain('Fix setup wrapper replacement first.');
    expect(msg).toContain('Do the work now.');
    expect(msg).toContain('When finished, report what changed');
  });

  it('strips Codex memory citation footers before relaying to Claude', () => {
    const msg = buildCodexToClaudeMessage([
      'Fix the watch glob bug.',
      '',
      '<oai-mem-citation>',
      '<citation_entries>',
      'MEMORY.md:1-2|note=[demo]',
      '</citation_entries>',
      '<rollout_ids>',
      '</rollout_ids>',
      '</oai-mem-citation>',
    ].join('\n'));
    expect(msg).toContain('Fix the watch glob bug.');
    expect(msg).toContain('Do the work now.');
    expect(msg).not.toContain('<oai-mem-citation>');
    expect(msg).not.toContain('MEMORY.md');
  });

  it('extracts the last Claude assistant text block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pagent-claude-log-'));
    const file = join(dir, 'claude.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-06T20:00:00.000Z',
        uuid: 'a1',
        stop_reason: 'end_turn',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'first reply' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-06T20:00:01.000Z',
        uuid: 'a2',
        stop_reason: 'end_turn',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'hidden' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-06T20:00:02.000Z',
        uuid: 'a3',
        stop_reason: 'end_turn',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'second reply' }],
        },
      }),
    ].join('\n') + '\n');

    const result = extractLastAssistantMessage(file, 'claude');
    expect(result.text).toBe('second reply');
    expect(result.key).toContain('a3');
  });

  it('does not relay a Claude tool-use text row as a finished response', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pagent-claude-tool-use-'));
    const file = join(dir, 'claude.jsonl');
    writeFileSync(file, [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-06T20:00:00.000Z',
        uuid: 'old',
        stop_reason: 'end_turn',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'old completed reply' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-06T20:00:01.000Z',
        uuid: 'mid-tool',
        stop_reason: 'tool_use',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'checking the repo before final answer' }],
        },
      }),
    ].join('\n') + '\n');

    const result = extractLastAssistantMessage(
      file,
      'claude',
      '2026-06-06T20:00:00.000Z:old:1'
    );
    expect(result).toBe(null);
  });

  it('extracts the last Codex assistant output text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pagent-codex-log-'));
    const file = join(dir, 'codex.jsonl');
    writeFileSync(file, [
      JSON.stringify({
        timestamp: '2026-06-06T20:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'codex reply one' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-06-06T20:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'codex reply two' }],
        },
      }),
    ].join('\n') + '\n');

    const result = extractLastAssistantMessage(file, 'codex');
    expect(result.text).toBe('codex reply two');
    expect(result.key).toContain('2026-06-06T20:00:01.000Z');
  });

  it('extracts Codex assistant output without requiring a final phase', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pagent-codex-phase-'));
    const file = join(dir, 'codex.jsonl');
    writeFileSync(file, [
      JSON.stringify({
        timestamp: '2026-06-06T20:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'status update' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-06-06T20:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'whatever-this-cli-calls-it',
          content: [{ type: 'output_text', text: 'final answer' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-06-06T20:00:02.000Z',
        type: 'task_complete',
      }),
    ].join('\n') + '\n');

    const result = extractLastAssistantMessage(file, 'codex');
    expect(result.text).toBe('final answer');
  });

  it('extracts assistant text using a custom adapter config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pagent-custom-adapter-'));
    const file = join(dir, 'custom.jsonl');
    writeFileSync(file, [
      JSON.stringify({ event: 'user', body: { text: 'hello' } }),
      JSON.stringify({
        event: 'bot-message',
        role: 'assistant',
        parts: [
          { kind: 'trace', value: 'hidden' },
          { kind: 'text', value: 'custom adapter reply' },
        ],
      }),
      JSON.stringify({ event: 'session-end' }),
    ].join('\n') + '\n');

    const result = extractLastAssistantMessage(file, 'custom', '', {
      adapters: {
        custom: {
          roots: [dir],
          assistant: {
            where: {
              event: 'bot-message',
              role: 'assistant',
            },
            text: [
              {
                array: 'parts',
                where: { kind: 'text' },
                path: 'value',
              },
            ],
          },
        },
      },
    });

    expect(result.text).toBe('custom adapter reply');
  });

  it('applies adapter strip patterns to extracted assistant text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pagent-strip-adapter-'));
    const file = join(dir, 'custom.jsonl');
    writeFileSync(file, JSON.stringify({
      event: 'bot-message',
      role: 'assistant',
      text: [
        'reply body',
        '',
        '<footer>',
        'debug stuff',
        '</footer>',
      ].join('\n'),
    }) + '\n');

    const result = extractLastAssistantMessage(file, 'custom', '', {
      adapters: {
        custom: {
          roots: [dir],
          assistant: {
            where: {
              event: 'bot-message',
              role: 'assistant',
            },
            text: [{ path: 'text' }],
          },
          stripPatterns: ['\\n*<footer>[\\s\\S]*?</footer>\\s*$'],
        },
      },
    });

    expect(result.text).toBe('reply body');
  });

  it('finds the newest transcript after launch time for each tool', () => {
    const root = mkdtempSync(join(tmpdir(), 'pagent-find-log-'));
    const codexRoot = join(root, 'codex', 'sessions');
    const claudeRoot = join(root, 'claude', 'projects');
    const fixtureCwd = '/tmp/pty-mgr-project';
    const claudeProject = join(claudeRoot, projectKeyForCwd(fixtureCwd));
    mkdirSync(codexRoot, { recursive: true });
    mkdirSync(claudeProject, { recursive: true });

    const oldCodex = join(codexRoot, 'old.jsonl');
    const newCodex = join(codexRoot, 'new.jsonl');
    const newClaude = join(claudeProject, 'new.jsonl');
    writeFileSync(oldCodex, '{}\n');
    writeFileSync(newCodex, '{}\n');
    writeFileSync(newClaude, '{}\n');

    const oldTime = new Date('2026-06-06T19:59:00.000Z');
    const newTime = new Date('2026-06-06T20:01:00.000Z');
    utimesSync(oldCodex, oldTime, oldTime);
    utimesSync(newCodex, newTime, newTime);
    utimesSync(newClaude, newTime, newTime);

    const config = {
      logs: {
        codex: { mainTranscripts: codexRoot, archivedTranscripts: join(root, 'missing') },
        claudeCode: { projectTranscripts: claudeRoot },
      },
    };

    expect(findNewestTranscript({
      kind: 'codex',
      cwd: fixtureCwd,
      sinceMs: Date.parse('2026-06-06T20:00:00.000Z'),
      config,
    })).toBe(newCodex);
    expect(findNewestTranscript({
      kind: 'claude',
      cwd: fixtureCwd,
      sinceMs: Date.parse('2026-06-06T20:00:00.000Z'),
      config,
    })).toBe(newClaude);
    expect(statSync(newClaude).mtimeMs).toBeGreaterThan(Date.parse('2026-06-06T20:00:00.000Z'));
  });

  it('selects the newest transcript when multiple sessions are after launch time', () => {
    const root = mkdtempSync(join(tmpdir(), 'pagent-newest-log-'));
    const codexRoot = join(root, 'codex', 'sessions');
    mkdirSync(codexRoot, { recursive: true });

    const first = join(codexRoot, 'first.jsonl');
    const second = join(codexRoot, 'second.jsonl');
    writeFileSync(first, JSON.stringify({
      timestamp: '2026-06-06T20:01:00.000Z',
      type: 'session_meta',
      payload: { timestamp: '2026-06-06T20:01:00.000Z' },
    }) + '\n');
    writeFileSync(second, JSON.stringify({
      timestamp: '2026-06-06T20:02:00.000Z',
      type: 'session_meta',
      payload: { timestamp: '2026-06-06T20:02:00.000Z' },
    }) + '\n');

    expect(findNewestTranscript({
      kind: 'codex',
      cwd: '/tmp/pty-mgr-project',
      sinceMs: Date.parse('2026-06-06T20:00:00.000Z'),
      config: {
        logs: {
          codex: { mainTranscripts: codexRoot },
        },
      },
    })).toBe(second);
  });

  it('selects the Codex transcript by session timestamp before mtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'pagent-codex-start-'));
    const codexRoot = join(root, 'codex', 'sessions');
    mkdirSync(codexRoot, { recursive: true });

    const olderSessionFreshMtime = join(codexRoot, 'older-fresh.jsonl');
    const launchedSession = join(codexRoot, 'launched.jsonl');
    writeFileSync(olderSessionFreshMtime, JSON.stringify({
      timestamp: '2026-06-06T20:00:00.000Z',
      type: 'session_meta',
      payload: {
        timestamp: '2026-06-06T20:00:00.000Z',
        cwd: '/tmp/pty-mgr-project',
      },
    }) + '\n');
    writeFileSync(launchedSession, JSON.stringify({
      timestamp: '2026-06-06T20:01:00.000Z',
      type: 'session_meta',
      payload: {
        timestamp: '2026-06-06T20:01:00.000Z',
        cwd: '/tmp/pty-mgr-project',
      },
    }) + '\n');

    const freshMtime = new Date('2026-06-06T20:03:00.000Z');
    utimesSync(olderSessionFreshMtime, freshMtime, freshMtime);

    expect(findNewestTranscript({
      kind: 'codex',
      cwd: '/tmp/pty-mgr-project',
      sinceMs: Date.parse('2026-06-06T20:00:30.000Z'),
      config: {
        logs: {
          codex: { mainTranscripts: codexRoot },
        },
      },
    })).toBe(launchedSession);
  });

  it('relays the latest response in dry-run mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pagent-relay-'));
    const codexRoot = join(root, 'codex', 'sessions');
    mkdirSync(codexRoot, { recursive: true });
    const logFile = join(codexRoot, 'codex.jsonl');
    writeFileSync(logFile, JSON.stringify({
      timestamp: '2026-06-06T20:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'tell the other agent this' }],
      },
    }) + '\n');

    const sent = [];
    const result = await runRelay({
      from: 'source-agent',
      to: 'target-agent',
      kind: 'codex',
      once: true,
      config: join(root, 'wrap.config'),
      stateDir: join(root, 'state'),
      intervalMs: 1,
      timeoutMs: 1,
    }, {
      sendMessage: (target, text) => sent.push({ target, text }),
      config: {
        logs: {
          codex: { mainTranscripts: codexRoot },
          claudeCode: { projectTranscripts: join(root, 'claude', 'projects') },
        },
      },
    });

    expect(result.sent).toBe(true);
    expect(result.text).toBe('tell the other agent this');
    expect(sent).toEqual([{ target: 'target-agent', text: 'tell the other agent this' }]);
  });

  it('runs one Claude worker / Codex planner cycle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pagent-duo-'));
    const stateDir = join(root, 'state');
    const sessionDir = join(stateDir, 'sessions');
    const claudeRoot = join(root, 'claude', 'projects');
    const codexRoot = join(root, 'codex', 'sessions');
    const cwd = '/tmp/pty-mgr-project';
    const claudeProject = join(claudeRoot, projectKeyForCwd(cwd));
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(stateDir, 'duos'), { recursive: true });
    mkdirSync(claudeProject, { recursive: true });
    mkdirSync(codexRoot, { recursive: true });

    writeFileSync(join(sessionDir, 'claude-1.json'), JSON.stringify({
      session: 'claude-1',
      kind: 'claude',
      cwd,
      startedAtMs: Date.parse('2026-06-06T20:00:00.000Z'),
    }));
    writeFileSync(join(sessionDir, 'codex-1.json'), JSON.stringify({
      session: 'codex-1',
      kind: 'codex',
      cwd,
      startedAtMs: Date.parse('2026-06-06T20:00:00.000Z'),
    }));

    writeFileSync(join(claudeProject, 'claude.jsonl'), JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-06T20:00:01.000Z',
      uuid: 'claude-a1',
      stop_reason: 'end_turn',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I reviewed the codebase and found wrapper drift.' }],
      },
    }) + '\n');
    writeFileSync(join(codexRoot, 'codex.jsonl'), JSON.stringify({
      timestamp: '2026-06-06T20:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Fix wrapper replacement first.' }],
      },
    }) + '\n');

    const sent = [];
    const watched = [];
    const result = await runDuo({
      claudeSession: 'claude-1',
      codexSession: 'codex-1',
      task: 'Notice any issues with this codebase.',
      stateDir,
      config: join(root, 'wrap.config'),
      intervalMs: 1,
      timeoutMs: 1,
      settleMs: 0,
      watchInterval: '10ms',
      maxCycles: 1,
    }, {
      sendMessage: (target, text) => sent.push({ target, text }),
      watchSession: (session, interval) => {
        watched.push({ session, interval });
        return 'done';
      },
      config: {
        logs: {
          codex: { mainTranscripts: codexRoot },
          claudeCode: { projectTranscripts: claudeRoot },
        },
      },
    });

    expect(result.completed).toBe(true);
    expect(sent[0]).toEqual({
      target: 'claude-1',
      text: 'Notice any issues with this codebase.',
    });
    expect(sent[1].target).toBe('codex-1');
    expect(sent[1].text).toContain('I reviewed the codebase and found wrapper drift.');
    expect(sent[1].text).toContain('What should I fix first and how?');
    expect(sent[2].target).toBe('claude-1');
    expect(sent[2].text).toContain('Fix wrapper replacement first.');
    expect(sent[2].text).toContain('Do the work now.');
    expect(watched).toEqual([
      { session: 'claude-1', interval: '10ms' },
      { session: 'codex-1', interval: '10ms' },
    ]);
  });

  it('can reset stale duo state when pty session names are reused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pagent-duo-reset-'));
    const stateDir = join(root, 'state');
    const sessionDir = join(stateDir, 'sessions');
    const claudeRoot = join(root, 'claude', 'projects');
    const codexRoot = join(root, 'codex', 'sessions');
    const cwd = '/tmp/pty-mgr-project';
    const claudeProject = join(claudeRoot, projectKeyForCwd(cwd));
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(stateDir, 'duos'), { recursive: true });
    mkdirSync(claudeProject, { recursive: true });
    mkdirSync(codexRoot, { recursive: true });

    writeFileSync(join(sessionDir, 'pty-mgr-1.json'), JSON.stringify({
      session: 'pty-mgr-1',
      kind: 'claude',
      cwd,
      startedAtMs: Date.parse('2026-06-06T20:00:00.000Z'),
    }));
    writeFileSync(join(sessionDir, 'pty-mgr-2.json'), JSON.stringify({
      session: 'pty-mgr-2',
      kind: 'codex',
      cwd,
      startedAtMs: Date.parse('2026-06-06T20:00:00.000Z'),
    }));
    writeFileSync(
      join(stateDir, 'duos', 'pty-mgr-1-with-pty-mgr-2.json'),
      JSON.stringify({
        cycles: 1,
        initialTaskSent: true,
        lastClaudeKey: 'old-claude',
        lastCodexKey: 'old-codex',
      })
    );
    writeFileSync(join(claudeProject, 'claude.jsonl'), JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-06T20:00:01.000Z',
      uuid: 'claude-a1',
      stop_reason: 'end_turn',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Fresh review result.' }],
      },
    }) + '\n');
    writeFileSync(join(codexRoot, 'codex.jsonl'), JSON.stringify({
      timestamp: '2026-06-06T20:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Fresh planner result.' }],
      },
    }) + '\n');

    resetDuoState('pty-mgr-1', 'pty-mgr-2', stateDir);

    const sent = [];
    const result = await runDuo({
      claudeSession: 'pty-mgr-1',
      codexSession: 'pty-mgr-2',
      task: 'Review this repo for obvious issues.',
      stateDir,
      config: join(root, 'wrap.config'),
      intervalMs: 1,
      timeoutMs: 1,
      settleMs: 0,
      watchInterval: '10ms',
      maxCycles: 1,
    }, {
      sendMessage: (target, text) => sent.push({ target, text }),
      watchSession: () => 'done',
      config: {
        logs: {
          codex: { mainTranscripts: codexRoot },
          claudeCode: { projectTranscripts: claudeRoot },
        },
      },
    });

    expect(result.completed).toBe(true);
    expect(sent[0]).toEqual({
      target: 'pty-mgr-1',
      text: 'Review this repo for obvious issues.',
    });
  });
});
