import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

// `p link a b` wires each agent's end-of-turn hook into the other's stdin.
// These tests drive the daemon side directly (posting the `turn` the hook
// posts) plus one end-to-end run of the real hook binary, so a break in
// either half fails here instead of stranding a live agent loop.
const DAEMON_NAME = `test-link-${Date.now()}`;
const SOCKET_PATH = join(homedir(), '.pty-manager', `${DAEMON_NAME}.sock`);
const RELAY_HOME = mkdtempSync(join(tmpdir(), 'plink-relay-'));

let daemonProc = null;

async function sendCmd(cmd) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(SOCKET_PATH);
    conn.on('error', reject);
    conn.on('connect', () => conn.write(JSON.stringify(cmd) + '\n'));
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        conn.end();
        try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
      }
    });
  });
}

const turn = (session, message) => sendCmd({ cmd: 'turn', name: session, args: { message } });
const links = async () => (await sendCmd({ cmd: 'links' })).links;
const linkFor = async (from) => (await links()).find((l) => l.from === from);

// delivery is detached from the `turn` reply (idle gate + send delay), so poll
async function waitForScreen(name, needle, maxMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const res = await sendCmd({ cmd: 'capture', name, args: { lines: 40 } });
    if (res.ok && (res.output || '').includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

beforeAll(async () => {
  daemonProc = Bun.spawn(['bun', 'bin/pty-mgr.mjs', `@${DAEMON_NAME}`, 'daemon'], {
    env: { ...process.env, __PTY_DAEMON_CHILD: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const start = Date.now();
  while (!existsSync(SOCKET_PATH) && Date.now() - start < 5000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!existsSync(SOCKET_PATH)) throw new Error('daemon socket never appeared');
  // `cat` echoes whatever is typed into it: a stand-in for an agent CLI that
  // needs no API key and settles instantly
  await sendCmd({ cmd: 'spawn', name: 'a', args: { cmd: 'cat' } });
  await sendCmd({ cmd: 'spawn', name: 'b', args: { cmd: 'cat' } });
});

afterAll(async () => {
  try { await sendCmd({ cmd: 'shutdown' }); } catch {}
  try { daemonProc?.kill(); } catch {}
});

describe('link registry', () => {
  it('links both directions by default', async () => {
    const res = await sendCmd({ cmd: 'link', name: 'a', args: { to: 'b' } });
    expect(res.ok).toBe(true);
    expect(res.links.map((l) => `${l.from}->${l.to}`).sort()).toEqual(['a->b', 'b->a']);
  });

  it('refuses a self-link and an unknown session', async () => {
    expect((await sendCmd({ cmd: 'link', name: 'a', args: { to: 'a' } })).ok).toBe(false);
    expect((await sendCmd({ cmd: 'link', name: 'a', args: { to: 'ghost' } })).ok).toBe(false);
    expect((await sendCmd({ cmd: 'link', name: 'a', args: {} })).ok).toBe(false);
  });

  it('--one-way links only the given direction', async () => {
    await sendCmd({ cmd: 'unlink', name: 'all' });
    await sendCmd({ cmd: 'link', name: 'a', args: { to: 'b', oneWay: true } });
    expect((await links()).map((l) => `${l.from}->${l.to}`)).toEqual(['a->b']);
  });

  it('unlink drops one pair, one name, or everything', async () => {
    await sendCmd({ cmd: 'link', name: 'a', args: { to: 'b' } });
    expect((await sendCmd({ cmd: 'unlink', name: 'a', args: { to: 'b' } })).removed).toBe(2);
    expect(await links()).toEqual([]);

    await sendCmd({ cmd: 'link', name: 'a', args: { to: 'b' } });
    expect((await sendCmd({ cmd: 'unlink', name: 'b' })).removed).toBe(2);
    expect(await links()).toEqual([]);

    await sendCmd({ cmd: 'link', name: 'a', args: { to: 'b' } });
    expect((await sendCmd({ cmd: 'unlink', name: 'all' })).removed).toBe(2);
    expect(await links()).toEqual([]);

    // a bare `unlink` must not be read as "unlink everything"
    expect((await sendCmd({ cmd: 'unlink' })).ok).toBe(false);
  });
});

describe('turn relay', () => {
  it('types a turn into the linked session', async () => {
    await sendCmd({ cmd: 'unlink', name: 'all' });
    await sendCmd({ cmd: 'link', name: 'a', args: { to: 'b' } });
    const res = await turn('a', 'BUG: null deref at foo.js:42\nhow should I fix it?');
    expect(res).toMatchObject({ ok: true, linked: true, to: 'b' });
    expect(await waitForScreen('b', 'null deref at foo.js:42')).toBe(true);
    expect((await linkFor('a')).count).toBe(1);
  }, 30000);

  it('relays the answer back the other way', async () => {
    const res = await turn('b', 'fix: guard before the deref');
    expect(res).toMatchObject({ ok: true, linked: true, to: 'a' });
    expect(await waitForScreen('a', 'guard before the deref')).toBe(true);
  }, 30000);

  it('drops a repeat of the same turn, an empty turn, and an unlinked session', async () => {
    expect(await turn('a', 'BUG: null deref at foo.js:42\nhow should I fix it?'))
      .toMatchObject({ linked: false, reason: 'duplicate turn' });
    expect(await turn('a', '   ')).toMatchObject({ linked: false, reason: 'empty turn' });
    expect(await turn('nobody', 'hi')).toMatchObject({ linked: false, reason: 'not linked' });
  });

  it('appends the note to every relayed turn', async () => {
    await sendCmd({ cmd: 'unlink', name: 'all' });
    await sendCmd({ cmd: 'link', name: 'a', args: { to: 'b', note: 'PLEASE-BE-BRIEF' } });
    await turn('a', 'noted turn');
    expect(await waitForScreen('b', 'PLEASE-BE-BRIEF')).toBe(true);
  }, 30000);

  it('stops the ping-pong at --max hops', async () => {
    await sendCmd({ cmd: 'unlink', name: 'all' });
    await sendCmd({ cmd: 'link', name: 'a', args: { to: 'b', max: 2, oneWay: true } });
    expect(await turn('a', 'hop one')).toMatchObject({ linked: true });
    expect(await turn('a', 'hop two')).toMatchObject({ linked: true });
    expect(await turn('a', 'hop three')).toMatchObject({ linked: false, reason: 'max hops reached' });
    expect((await linkFor('a')).count).toBe(2);
  }, 30000);

  it('reports a dead target instead of throwing', async () => {
    await sendCmd({ cmd: 'unlink', name: 'all' });
    await sendCmd({ cmd: 'spawn', name: 'doomed', args: { cmd: 'cat' } });
    await sendCmd({ cmd: 'link', name: 'a', args: { to: 'doomed' } });
    await sendCmd({ cmd: 'kill', name: 'doomed' });
    // SIGTERM is asynchronous: post the turn only once the child is really
    // gone, otherwise the relay takes the live path and the assertion races
    const dead = Date.now();
    while (Date.now() - dead < 10000) {
      const res = await sendCmd({ cmd: 'alive', name: 'doomed' });
      if (res.ok && !res.alive) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await turn('a', 'anyone home?')).toMatchObject({ linked: true });
    const start = Date.now();
    while (Date.now() - start < 10000) {
      if ((await linkFor('a'))?.lastStatus?.startsWith('dead:')) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect((await linkFor('a')).lastStatus).toBe('dead: doomed');
  }, 30000);

  it('forgets links to a removed session', async () => {
    await sendCmd({ cmd: 'remove', name: 'doomed' });
    expect(await links()).toEqual([]);
  });

  it('follows a renamed session', async () => {
    await sendCmd({ cmd: 'link', name: 'a', args: { to: 'b' } });
    await sendCmd({ cmd: 'rename', name: 'b', args: { newName: 'b2' } });
    expect((await links()).map((l) => `${l.from}->${l.to}`).sort()).toEqual(['a->b2', 'b2->a']);
    await sendCmd({ cmd: 'rename', name: 'b2', args: { newName: 'b' } });
  });
});

describe('end-of-turn hook', () => {
  it('reads a claude Stop payload and delivers the turn to the linked session', async () => {
    await sendCmd({ cmd: 'unlink', name: 'all' });
    await sendCmd({ cmd: 'link', name: 'a', args: { to: 'b' } });

    const transcript = join(RELAY_HOME, 'transcript.jsonl');
    writeFileSync(transcript, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-30T20:00:02.000Z',
        uuid: 'a9',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'HOOK-RELAY off-by-one in parse.js:88' }],
        },
      }),
    ].join('\n') + '\n');

    const proc = Bun.spawn(['bun', 'bin/pty-mgr.mjs', 'relay', 'hook'], {
      env: {
        ...process.env,
        PTY_MGR_SESSION: 'a',
        PTY_MGR_DAEMON: DAEMON_NAME,
        PTY_MGR_RELAY_HOME: RELAY_HOME, // keep the router half off the real config
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    proc.stdin.write(JSON.stringify({
      session_id: 'x',
      transcript_path: transcript,
      hook_event_name: 'Stop',
      cwd: process.cwd(),
    }));
    proc.stdin.end();
    expect(await proc.exited).toBe(0);

    expect(await waitForScreen('b', 'HOOK-RELAY off-by-one in parse.js:88')).toBe(true);
  }, 30000);
});
