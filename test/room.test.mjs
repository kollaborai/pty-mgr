import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

// A chat room (`p daemon @@name`) is `p link` with N members: every session in
// the daemon hears every other one, prefixed with the speaker's name, and
// membership is just being spawned here. Room mode is set at daemon boot, so
// these need their own daemon started with the `@@` selector.
const DAEMON_NAME = `test-room-${Date.now()}`;
const SOCKET_PATH = join(homedir(), '.pty-manager', `${DAEMON_NAME}.sock`);
const RELAY_HOME = mkdtempSync(join(tmpdir(), 'proom-relay-'));

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
const room = async () => (await sendCmd({ cmd: 'links' })).room;

async function waitForScreen(name, needle, maxMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const res = await sendCmd({ cmd: 'capture', name, args: { lines: 40 } });
    if (res.ok && (res.output || '').includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const screen = async (name) => (await sendCmd({ cmd: 'capture', name, args: { lines: 40 } })).output || '';

beforeAll(async () => {
  // `@@name` is what makes this daemon a room -- a plain `@name` boot would not
  daemonProc = Bun.spawn(['bun', 'bin/pty-mgr.mjs', `@@${DAEMON_NAME}`, 'daemon'], {
    env: { ...process.env, __PTY_DAEMON_CHILD: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const start = Date.now();
  while (!existsSync(SOCKET_PATH) && Date.now() - start < 5000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!existsSync(SOCKET_PATH)) throw new Error('daemon socket never appeared');
  for (const n of ['advisor', 'bug-finder', 'coder']) {
    await sendCmd({ cmd: 'spawn', name: n, args: { cmd: 'cat' } });
  }
});

afterAll(async () => {
  try { await sendCmd({ cmd: 'shutdown' }); } catch {}
  try { daemonProc?.kill(); } catch {}
});

describe('chat room', () => {
  it('boots in room mode from the @@ selector, with every session a member', async () => {
    const r = await room();
    expect(r.on).toBe(true);
    expect(r.members.sort()).toEqual(['advisor', 'bug-finder', 'coder']);
  });

  it('broadcasts a turn to everyone but the speaker, prefixed with the speaker', async () => {
    const res = await turn('bug-finder', 'null deref at parse.js:88 — how do I fix it?');
    expect(res).toMatchObject({ ok: true, linked: true, room: true });
    expect(res.to.sort()).toEqual(['advisor', 'coder']);
    expect(await waitForScreen('advisor', 'bug-finder: null deref at parse.js:88')).toBe(true);
    expect(await waitForScreen('coder', 'bug-finder: null deref at parse.js:88')).toBe(true);
    // the speaker must not hear its own turn back
    expect(await screen('bug-finder')).not.toContain('bug-finder: null deref');
    expect((await room()).broadcasts).toBe(1);
  }, 30000);

  it('includes a session spawned into a running room', async () => {
    await sendCmd({ cmd: 'spawn', name: 'latecomer', args: { cmd: 'cat' } });
    const res = await turn('advisor', 'guard it, then add a regression test');
    expect(res.to.sort()).toEqual(['bug-finder', 'coder', 'latecomer']);
    expect(await waitForScreen('latecomer', 'advisor: guard it')).toBe(true);
  }, 30000);

  it('drops a repeat turn and an empty turn', async () => {
    expect(await turn('advisor', 'guard it, then add a regression test'))
      .toMatchObject({ linked: false, reason: 'duplicate turn' });
    expect(await turn('advisor', '  ')).toMatchObject({ linked: false, reason: 'empty turn' });
  });

  it('refuses a pairwise link inside a room', async () => {
    const res = await sendCmd({ cmd: 'link', name: 'advisor', args: { to: 'coder' } });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('chat room');
  });

  it('reports room mode in status', async () => {
    const st = (await sendCmd({ cmd: 'status' })).status;
    expect(st.room.on).toBe(true);
    expect(st.room.broadcasts).toBeGreaterThan(0);
  });

  it('unlink all leaves room mode without killing the agents; link all restores it', async () => {
    expect((await sendCmd({ cmd: 'unlink', name: 'all' })).room.on).toBe(false);
    expect(await turn('advisor', 'anyone still listening?'))
      .toMatchObject({ linked: false, reason: 'not linked' });
    // the sessions are untouched by the kill switch
    expect((await sendCmd({ cmd: 'alive', name: 'coder' })).alive).toBe(true);

    expect((await sendCmd({ cmd: 'link', name: 'all' })).room.on).toBe(true);
    expect(await turn('advisor', 'back on the air')).toMatchObject({ linked: true, room: true });
  }, 30000);

  it('stops broadcasting at --max total room turns', async () => {
    await sendCmd({ cmd: 'unlink', name: 'all' });
    await sendCmd({ cmd: 'link', name: 'all', args: { max: 2 } });
    expect(await turn('advisor', 'standing by')).toMatchObject({ linked: true, room: true });
    expect(await turn('coder', 'holding')).toMatchObject({ linked: true, room: true });
    expect(await turn('advisor', 'acknowledged')).toMatchObject({ linked: false, reason: 'max hops reached' });
    expect((await room()).broadcasts).toBe(2);
    // unlink all is the documented full reset -- clears the cap along with the links
    await sendCmd({ cmd: 'unlink', name: 'all' });
    await sendCmd({ cmd: 'link', name: 'all' });
  }, 30000);

  it('says so when the speaker is alone in the room', async () => {
    for (const n of ['bug-finder', 'coder', 'latecomer']) {
      await sendCmd({ cmd: 'remove', name: n });
    }
    expect(await turn('advisor', 'hello? anybody?')).toMatchObject({ linked: true, to: [] });
    const start = Date.now();
    while (Date.now() - start < 10000) {
      if ((await room()).lastStatus === 'nobody else in the room') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect((await room()).lastStatus).toBe('nobody else in the room');
  }, 30000);
});

describe('end-of-turn hook in a room', () => {
  it('reads a claude Stop payload and broadcasts it to the room', async () => {
    await sendCmd({ cmd: 'spawn', name: 'listener', args: { cmd: 'cat' } });

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
          content: [{ type: 'text', text: 'ROOM-HOOK shipping the fix now' }],
        },
      }),
    ].join('\n') + '\n');

    const proc = Bun.spawn(['bun', 'bin/pty-mgr.mjs', 'relay', 'hook'], {
      env: {
        ...process.env,
        PTY_MGR_SESSION: 'advisor',
        PTY_MGR_DAEMON: DAEMON_NAME,
        PTY_MGR_RELAY_HOME: RELAY_HOME,
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

    expect(await waitForScreen('listener', 'advisor: ROOM-HOOK shipping the fix now')).toBe(true);
  }, 30000);
});
