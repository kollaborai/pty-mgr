import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  buildFlowTurnMessage,
  extractLastAssistantMessage,
  findNewestTranscript,
  projectKeyForCwd,
  runFlowWorkflow,
} from '../lib/pty-manager.mjs';

function adapterConfig({ codexRoot, claudeRoot, extraCodexRoot, flows = {} }) {
  const adapters = {};
  if (codexRoot) {
    adapters.codex = {
      roots: [codexRoot, extraCodexRoot].filter(Boolean),
      sessionTimestampPaths: ['payload.timestamp', 'timestamp'],
      assistant: {
        where: {
          type: 'response_item',
          'payload.type': 'message',
          'payload.role': 'assistant',
        },
        text: [{ array: 'payload.content', where: { type: 'output_text' }, path: 'text' }],
      },
      user: {
        where: {
          type: 'response_item',
          'payload.type': 'message',
          'payload.role': 'user',
        },
        text: [{ array: 'payload.content', where: { type: 'input_text' }, path: 'text' }],
      },
      stripPatterns: ['\\n*<oai-mem-citation>[\\s\\S]*?</oai-mem-citation>\\s*$'],
    };
  }
  if (claudeRoot) {
    adapters.claude = {
      roots: [join(claudeRoot, '${projectKey}'), claudeRoot],
      sessionTimestampPaths: ['timestamp'],
      assistant: {
        where: { type: 'assistant' },
        complete: { 'message.stop_reason': 'end_turn' },
        text: [{ array: 'message.content', where: { type: 'text' }, path: 'text' }],
      },
      user: {
        where: { type: 'user', 'message.role': 'user' },
        text: [
          { path: 'message.content' },
          { array: 'message.content', where: { type: 'text' }, path: 'text' },
        ],
      },
    };
  }
  return { adapters, flows };
}

describe('flow log tailing', () => {
  it('extracts the last Claude completed assistant text block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pflow-claude-log-'));
    const file = join(dir, 'claude.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-06T20:00:00.000Z',
        uuid: 'a1',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'first reply' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-06T20:00:01.000Z',
        uuid: 'a2',
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [{ type: 'text', text: 'checking files' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-06T20:00:02.000Z',
        uuid: 'a3',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'second reply' }],
        },
      }),
    ].join('\n') + '\n');

    const result = extractLastAssistantMessage(file, 'claude', '', adapterConfig({ claudeRoot: dir }));
    expect(result.text).toBe('second reply');
    expect(result.key).toContain('a3');
  });

  it('does not treat a Claude tool-use text row as a finished response', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pflow-claude-tool-use-'));
    const file = join(dir, 'claude.jsonl');
    writeFileSync(file, [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-06T20:00:00.000Z',
        uuid: 'old',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'old completed reply' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-06T20:00:01.000Z',
        uuid: 'mid-tool',
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [{ type: 'text', text: 'checking the repo before final answer' }],
        },
      }),
    ].join('\n') + '\n');

    const result = extractLastAssistantMessage(
      file,
      'claude',
      '2026-06-06T20:00:00.000Z:old:1',
      adapterConfig({ claudeRoot: dir })
    );
    expect(result).toBe(null);
  });

  it('extracts Codex assistant output and strips configured footers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pflow-codex-log-'));
    const file = join(dir, 'codex.jsonl');
    writeFileSync(file, JSON.stringify({
      timestamp: '2026-06-06T20:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: [
            'codex reply two',
            '',
            '<oai-mem-citation>',
            '<citation_entries>',
            'MEMORY.md:1-2|note=[demo]',
            '</citation_entries>',
            '<rollout_ids>',
            '</rollout_ids>',
            '</oai-mem-citation>',
          ].join('\n'),
        }],
      },
    }) + '\n');

    const result = extractLastAssistantMessage(file, 'codex', '', adapterConfig({ codexRoot: dir }));
    expect(result.text).toBe('codex reply two');
  });

  it('extracts assistant text using a custom adapter config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pflow-custom-adapter-'));
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
    ].join('\n') + '\n');

    const result = extractLastAssistantMessage(file, 'custom', '', {
      adapters: {
        custom: {
          roots: [dir],
          assistant: {
            where: { event: 'bot-message', role: 'assistant' },
            text: [{ array: 'parts', where: { kind: 'text' }, path: 'value' }],
          },
        },
      },
    });

    expect(result.text).toBe('custom adapter reply');
  });

  it('does not fall back to older line-number keys after the last message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pflow-line-key-'));
    const file = join(dir, 'custom.jsonl');
    writeFileSync(file, Array.from({ length: 10 }, (_, index) => JSON.stringify({
      event: 'bot-message',
      role: 'assistant',
      parts: [{ kind: 'text', value: `reply ${index + 1}` }],
    })).join('\n') + '\n');

    const config = {
      adapters: {
        custom: {
          roots: [dir],
          assistant: {
            where: { event: 'bot-message', role: 'assistant' },
            text: [{ array: 'parts', where: { kind: 'text' }, path: 'value' }],
          },
        },
      },
    };

    const last = extractLastAssistantMessage(file, 'custom', '', config);
    expect(last.text).toBe('reply 10');
    expect(extractLastAssistantMessage(file, 'custom', last.key, config)).toBe(null);
  });

  it('requires an explicit adapter for each agent kind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pflow-no-adapter-'));
    const file = join(dir, 'claude.jsonl');
    writeFileSync(file, JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'reply body' }],
      },
    }) + '\n');

    expect(() => extractLastAssistantMessage(file, 'claude', '', { adapters: {} }))
      .toThrow('missing adapter config for agent kind: claude');
  });

  it('finds the newest transcript after launch time for each tool', () => {
    const root = mkdtempSync(join(tmpdir(), 'pflow-find-log-'));
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

    const config = adapterConfig({ codexRoot, claudeRoot });
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
});

describe('flow orchestration', () => {
  it('builds turn messages from append steering and templates', () => {
    expect(buildFlowTurnMessage({
      append: 'Based on this, what should happen next for {goal}?',
    }, {
      lastMessage: 'first answer',
      goal: 'ship a spec',
    })).toBe('first answer\n\nBased on this, what should happen next for ship a spec?');

    expect(buildFlowTurnMessage({
      template: 'cycle={cycle} from={from} to={to}\n{lastMessage}\n{task}',
    }, {
      cycle: 2,
      from: 'author',
      to: 'reviewer',
      lastMessage: 'draft',
      task: 'write a spec',
    })).toBe('cycle=2 from=author to=reviewer\ndraft\nwrite a spec');
  });

  it('runs one configured author/reviewer flow cycle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pflow-run-'));
    const claudeRoot = join(root, 'claude', 'projects');
    const codexRoot = join(root, 'codex', 'sessions');
    const cwd = '/tmp/pty-mgr-project';
    const claudeProject = join(claudeRoot, projectKeyForCwd(cwd));
    mkdirSync(claudeProject, { recursive: true });
    mkdirSync(codexRoot, { recursive: true });

    writeFileSync(join(claudeProject, 'claude.jsonl'), [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-06-06T20:00:00.500Z',
        uuid: 'claude-u1',
        message: { role: 'user', content: 'Write a spec.' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-06T20:00:01.000Z',
        uuid: 'claude-a1',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Drafted the spec.' }],
        },
      }),
    ].join('\n') + '\n');
    writeFileSync(join(codexRoot, 'codex.jsonl'), [
      JSON.stringify({
        timestamp: '2026-06-06T20:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: 'Drafted the spec.\n\nBased on this, what gaps do you see?',
          }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-06-06T20:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Add acceptance criteria.' }],
        },
      }),
    ].join('\n') + '\n');

    const sent = [];
    const launched = [];
    const config = adapterConfig({
      codexRoot,
      claudeRoot,
      flows: {
        spec: {
          agents: {
            author: { kind: 'claude' },
            reviewer: { kind: 'codex' },
          },
          start: { to: 'author', template: '{task}' },
          turns: [
            {
              from: 'author',
              to: 'reviewer',
              append: 'Based on this, what gaps do you see?',
            },
            {
              from: 'reviewer',
              to: 'author',
              append: 'Use this feedback to continue toward {goal}.',
            },
          ],
          maxCycles: 1,
          watchInterval: '1ms',
          settleMs: 0,
        },
      },
    });

    const result = await runFlowWorkflow({
      workflow: 'spec',
      task: 'Write a spec.',
      goal: 'a complete spec',
      cwd,
      intervalMs: 1,
      timeoutMs: 1,
    }, {
      config,
      launchAgent: (alias, meta) => {
        launched.push({ alias, ...meta });
        return {
          alias,
          session: `${alias}-session`,
          kind: meta.kind,
          cwd,
          startedAtMs: Date.parse('2026-06-06T20:00:00.000Z'),
        };
      },
      sendMessage: (target, text) => sent.push({ target, text }),
      watchSession: () => 'done',
    });

    expect(result.completed).toBe(true);
    expect(launched.map((agent) => agent.alias)).toEqual(['author', 'reviewer']);
    expect(sent[0]).toEqual({ target: 'author-session', text: 'Write a spec.' });
    expect(sent[1].target).toBe('reviewer-session');
    expect(sent[1].text).toContain('Drafted the spec.');
    expect(sent[1].text).toContain('Based on this, what gaps do you see?');
    expect(sent[2].target).toBe('author-session');
    expect(sent[2].text).toContain('Add acceptance criteria.');
    expect(sent[2].text).toContain('Use this feedback to continue toward a complete spec.');
  });

  it('binds each agent to the transcript containing the sent prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pflow-bind-log-'));
    const claudeRoot = join(root, 'claude', 'projects');
    const codexRoot = join(root, 'codex', 'sessions');
    const cwd = '/tmp/pty-mgr-project';
    const claudeProject = join(claudeRoot, projectKeyForCwd(cwd));
    mkdirSync(claudeProject, { recursive: true });
    mkdirSync(codexRoot, { recursive: true });

    const targetClaude = join(claudeProject, 'target.jsonl');
    const wrongClaude = join(claudeProject, 'wrong-newer.jsonl');
    writeFileSync(targetClaude, [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-06-06T20:00:01.000Z',
        uuid: 'user-target',
        message: { role: 'user', content: 'Write a spec.' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-06T20:00:02.000Z',
        uuid: 'assistant-target',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'target spec draft' }],
        },
      }),
    ].join('\n') + '\n');
    writeFileSync(wrongClaude, JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-06T20:00:03.000Z',
      uuid: 'assistant-wrong',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'wrong newer draft' }],
      },
    }) + '\n');

    const oldTime = new Date('2026-06-06T20:00:02.000Z');
    const newerTime = new Date('2026-06-06T20:00:03.000Z');
    utimesSync(targetClaude, oldTime, oldTime);
    utimesSync(wrongClaude, newerTime, newerTime);

    writeFileSync(join(codexRoot, 'codex.jsonl'), [
      JSON.stringify({
        timestamp: '2026-06-06T20:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'target spec draft\n\nreview it' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-06-06T20:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'target review' }],
        },
      }),
    ].join('\n') + '\n');

    const sent = [];
    const config = adapterConfig({
      codexRoot,
      claudeRoot,
      flows: {
        spec: {
          agents: {
            author: { kind: 'claude' },
            reviewer: { kind: 'codex' },
          },
          start: { to: 'author', template: '{task}' },
          turns: [
            { from: 'author', to: 'reviewer', append: 'review it' },
          ],
          maxCycles: 1,
          watchInterval: '1ms',
          settleMs: 0,
        },
      },
    });

    await runFlowWorkflow({
      workflow: 'spec',
      task: 'Write a spec.',
      cwd,
      intervalMs: 1,
      timeoutMs: 1,
    }, {
      config,
      launchAgent: (alias, meta) => ({
        alias,
        session: `${alias}-session`,
        kind: meta.kind,
        cwd,
        startedAtMs: Date.parse('2026-06-06T20:00:00.000Z'),
      }),
      sendMessage: (target, text) => sent.push({ target, text }),
      watchSession: () => 'done',
    });

    expect(sent[1].text).toContain('target spec draft');
    expect(sent[1].text).not.toContain('wrong newer draft');
  });

  it('supports reused sessions whose transcript started before the flow run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pflow-reused-session-'));
    const claudeRoot = join(root, 'claude', 'projects');
    const codexRoot = join(root, 'codex', 'sessions');
    const cwd = '/tmp/pty-mgr-project';
    const claudeProject = join(claudeRoot, projectKeyForCwd(cwd));
    mkdirSync(claudeProject, { recursive: true });
    mkdirSync(codexRoot, { recursive: true });

    writeFileSync(join(claudeProject, 'reused.jsonl'), [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-06-06T19:00:00.000Z',
        uuid: 'old-user',
        message: { role: 'user', content: 'Write a spec.' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-06T19:00:01.000Z',
        uuid: 'old-assistant',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'reused session draft' }],
        },
      }),
    ].join('\n') + '\n');
    writeFileSync(join(codexRoot, 'codex.jsonl'), [
      JSON.stringify({
        timestamp: '2026-06-06T19:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'reused session draft\n\nreview it' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-06-06T19:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'review complete' }],
        },
      }),
    ].join('\n') + '\n');

    const sent = [];
    const config = adapterConfig({
      codexRoot,
      claudeRoot,
      flows: {
        spec: {
          agents: {
            author: { kind: 'claude', session: 'existing-author' },
            reviewer: { kind: 'codex' },
          },
          start: { to: 'author', template: '{task}' },
          turns: [{ from: 'author', to: 'reviewer', append: 'review it' }],
          maxCycles: 1,
          watchInterval: '1ms',
          settleMs: 0,
        },
      },
    });

    const result = await runFlowWorkflow({
      workflow: 'spec',
      task: 'Write a spec.',
      cwd,
      intervalMs: 1,
      timeoutMs: 1,
    }, {
      config,
      launchAgent: (alias, meta) => ({
        alias,
        session: `${alias}-session`,
        kind: meta.kind,
        cwd,
        startedAtMs: Date.parse('2026-06-06T20:00:00.000Z'),
      }),
      sendMessage: (target, text) => sent.push({ target, text }),
      watchSession: () => 'done',
    });

    expect(result.completed).toBe(true);
    expect(sent[1].text).toContain('reused session draft');
  });

  it('requires flow agents to declare kind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pflow-agent-kind-'));
    const config = adapterConfig({
      claudeRoot: root,
      flows: {
        bad: {
          agents: {
            author: { adapter: 'claude' },
          },
          start: { to: 'author', template: '{task}' },
          turns: [{ from: 'author', to: 'author', append: 'continue' }],
        },
      },
    });

    await expect(runFlowWorkflow({
      workflow: 'bad',
      task: 'Write a spec.',
    }, {
      config,
      launchAgent: () => {
        throw new Error('should not launch');
      },
    })).rejects.toThrow('flow agent author must define kind');
  });
});
