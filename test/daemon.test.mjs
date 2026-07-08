import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';

const DAEMON_NAME = `test-daemon-${Date.now()}`;
const SOCKET_PATH = join(homedir(), '.pty-manager', `${DAEMON_NAME}.sock`);

let daemonProc = null;

async function sendCmd(cmd) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(SOCKET_PATH);
    conn.on('error', reject);
    conn.on('connect', () => {
      conn.write(JSON.stringify(cmd) + '\n');
    });
    let buf = '';
    conn.on('data', d => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        conn.end();
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (e) {
          reject(e);
        }
      }
    });
    conn.on('end', () => {
      if (buf && !buf.includes('\n')) {
        try {
          resolve(JSON.parse(buf));
        } catch (e) {
          reject(new Error(`No newline in response: ${buf}`));
        }
      }
    });
  });
}

function waitForSocket(maxMs = 3000, interval = 100) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (existsSync(SOCKET_PATH)) {
        resolve(true);
      } else if (Date.now() - start > maxMs) {
        reject(new Error(`Socket not appeared after ${maxMs}ms`));
      } else {
        setTimeout(check, interval);
      }
    };
    check();
  });
}

async function startDaemon() {
  daemonProc = Bun.spawn(['bun', 'bin/pty-mgr.mjs', `@${DAEMON_NAME}`, 'daemon'], {
    env: { ...process.env, __PTY_DAEMON_CHILD: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await waitForSocket();
  await new Promise(r => setTimeout(r, 500));
}

async function stopDaemon() {
  try {
    await sendCmd({ cmd: 'stop' });
  } catch {}
  try {
    daemonProc?.kill();
  } catch {}
  try {
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  } catch {}
}

describe('daemon protocol', () => {
  beforeAll(async () => {
    await startDaemon();
  }, 10000);

  afterAll(async () => {
    await stopDaemon();
  });

  describe('spawn + capture', () => {
    it('spawns an echo command and captures output', async () => {
      const spawnRes = await sendCmd({
        cmd: 'spawn',
        name: 's1',
        args: { cmd: 'echo', args: ['hello'] },
      });
      expect(spawnRes.ok).toBe(true);
      expect(spawnRes.name).toBe('s1');
      expect(typeof spawnRes.pid).toBe('number');

      await new Promise(r => setTimeout(r, 500));

      const capRes = await sendCmd({
        cmd: 'capture',
        name: 's1',
        args: { lines: 5 },
      });
      expect(capRes.ok).toBe(true);
      expect(capRes.output).toContain('hello');
    });

    it('rejects duplicate session names', async () => {
      const res = await sendCmd({
        cmd: 'spawn',
        name: 's1',
        args: { cmd: 'echo', args: ['dup'] },
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBeTruthy();
    });
  });

  describe('send', () => {
    it('sends keys to a zsh session and captures result', async () => {
      const spawnRes = await sendCmd({
        cmd: 'spawn',
        name: 'send-test',
        args: { cmd: 'zsh' },
      });
      expect(spawnRes.ok).toBe(true);

      await new Promise(r => setTimeout(r, 300));

      await sendCmd({
        cmd: 'send',
        name: 'send-test',
        args: { text: 'echo test123\r' },
      });

      await new Promise(r => setTimeout(r, 500));

      const capRes = await sendCmd({
        cmd: 'capture',
        name: 'send-test',
        args: { lines: 10 },
      });
      expect(capRes.ok).toBe(true);
      expect(capRes.output).toContain('test123');
    });
  });

  describe('kill + remove', () => {
    it('kills a session and reports it not alive', async () => {
      await sendCmd({
        cmd: 'spawn',
        name: 'kill-test',
        args: { cmd: 'zsh' },
      });

      const killRes = await sendCmd({
        cmd: 'kill',
        name: 'kill-test',
      });
      expect(killRes.ok).toBe(true);
      expect(killRes.killed).toContain('kill-test');

      await new Promise(r => setTimeout(r, 300));
      const aliveRes = await sendCmd({
        cmd: 'alive',
        name: 'kill-test',
      });
      expect(aliveRes.ok).toBe(true);
      expect(aliveRes.alive).toBe(false);
    });

    it('removes a session from registry', async () => {
      const removeRes = await sendCmd({
        cmd: 'remove',
        name: 'kill-test',
      });
      expect(removeRes.ok).toBe(true);
      expect(removeRes.removed).toContain('kill-test');
    });
  });

  describe('wrap', () => {
    it('wraps a command in tmp directory', async () => {
      const res = await sendCmd({
        cmd: 'wrap',
        args: { cmd: 'zsh', cwd: '/tmp' },
      });
      expect(res.ok).toBe(true);
      expect(res.name).toMatch(/^tmp-\d+$/);
      expect(typeof res.pid).toBe('number');
    });

    it('increments wrap counter for same cwd', async () => {
      const res1 = await sendCmd({
        cmd: 'wrap',
        args: { cmd: 'zsh', cwd: '/tmp' },
      });
      const res2 = await sendCmd({
        cmd: 'wrap',
        args: { cmd: 'zsh', cwd: '/tmp' },
      });
      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);
      expect(res1.name).not.toBe(res2.name);
    });

    it('uses base from cwd for wrap name', async () => {
      const res = await sendCmd({
        cmd: 'wrap',
        args: { cmd: '/bin/echo', args: ['hi'], cwd: '/tmp', base: 'my.project' },
      });
      expect(res.ok).toBe(true);
      expect(res.name).toMatch(/^my\.project-\d+$/);
    });

    it('does not execute shell metacharacters in wrap args', async () => {
      // Command substitution fires inside double quotes (the old
      // `a.includes(" ") ? '"'+a+'"'` quoting) but is inert inside the single
      // quotes shellQuote() now produces. `MARKER_` prints either way, and the
      // substitution resolves *before* echo prints -- so once MARKER_ is on
      // screen we can assert deterministically (no arbitrary sleep race) that
      // the sentinel was NOT created.
      const dir = mkdtempSync(join(tmpdir(), 'pty-mgr-wrap-inject-'));
      const sentinel = join(dir, 'pwned');
      const res = await sendCmd({
        cmd: 'wrap',
        args: { cmd: '/bin/echo', args: [`MARKER_$(touch ${sentinel})`], cwd: dir, base: 'inject' },
      });
      expect(res.ok).toBe(true);

      let printed = false;
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 200));
        const cap = await sendCmd({ cmd: 'capture', name: res.name, args: { lines: 20 } });
        if (cap.ok && cap.output && cap.output.includes('MARKER_')) { printed = true; break; }
      }
      expect(printed).toBe(true);
      expect(existsSync(sentinel)).toBe(false);
    });

    it('filters non-whitelisted client env from wrap', async () => {
      // wrap should inherit the daemon env but drop arbitrary client-supplied
      // vars. PATH (whitelisted) always prints; PTYMGR_EVIL_INJECT (not) must
      // never reach the child. Poll until env has printed (PATH= visible).
      const res = await sendCmd({
        cmd: 'wrap',
        args: {
          cmd: '/usr/bin/env',
          cwd: '/tmp',
          base: 'envfilter',
          env: { PTYMGR_EVIL_INJECT: 'pwned' },
        },
      });
      expect(res.ok).toBe(true);

      let output = '';
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 200));
        const cap = await sendCmd({ cmd: 'capture', name: res.name, args: { lines: 200 } });
        output = (cap.ok && cap.output) || '';
        if (output.includes('PATH=')) break;
      }
      expect(output).toContain('PATH=');
      expect(output).not.toContain('PTYMGR_EVIL_INJECT');
    });
  });

  describe('bulk operations', () => {
    it('kills all sessions with "all" keyword', async () => {
      await sendCmd({ cmd: 'spawn', name: 'bulk-a', args: { cmd: 'zsh' } });
      await sendCmd({ cmd: 'spawn', name: 'bulk-b', args: { cmd: 'zsh' } });
      await sendCmd({ cmd: 'spawn', name: 'bulk-c', args: { cmd: 'zsh' } });

      const res = await sendCmd({ cmd: 'kill', name: 'all' });
      expect(res.ok).toBe(true);
      expect(res.killed).toContain('bulk-a');
      expect(res.killed).toContain('bulk-b');
      expect(res.killed).toContain('bulk-c');
    });

    it('kills sessions matching glob pattern', async () => {
      await sendCmd({ cmd: 'spawn', name: 'test-a', args: { cmd: 'zsh' } });
      await sendCmd({ cmd: 'spawn', name: 'test-b', args: { cmd: 'zsh' } });
      await sendCmd({ cmd: 'spawn', name: 'other', args: { cmd: 'zsh' } });

      const res = await sendCmd({ cmd: 'kill', name: 'test-*' });
      expect(res.ok).toBe(true);
      expect(res.killed).toContain('test-a');
      expect(res.killed).toContain('test-b');
      expect(res.killed).not.toContain('other');
    });
  });

  describe('list', () => {
    it('lists all active sessions', async () => {
      await sendCmd({ cmd: 'spawn', name: 'list-1', args: { cmd: 'zsh' } });
      await sendCmd({ cmd: 'spawn', name: 'list-2', args: { cmd: 'zsh' } });

      const res = await sendCmd({ cmd: 'list' });
      expect(res.ok).toBe(true);
      expect(Array.isArray(res.sessions)).toBe(true);
      expect(res.sessions.some(s => s.name === 'list-1')).toBe(true);
      expect(res.sessions.some(s => s.name === 'list-2')).toBe(true);
    });
  });

  describe('rename', () => {
    it('renames a session', async () => {
      await sendCmd({ cmd: 'spawn', name: 'old-name', args: { cmd: 'zsh' } });

      const res = await sendCmd({
        cmd: 'rename',
        name: 'old-name',
        args: { newName: 'new-name' },
      });
      expect(res.ok).toBe(true);
      expect(res.oldName).toBe('old-name');
      expect(res.newName).toBe('new-name');
    });
  });

  describe('attach', () => {
    // speak the attach protocol raw: send the request, collect ack + replay
    function attachCollect(name, ms = 1000) {
      return new Promise((resolve, reject) => {
        const conn = createConnection(SOCKET_PATH);
        let buf = '';
        conn.on('error', reject);
        conn.on('connect', () => {
          conn.write(JSON.stringify({ cmd: 'attach', name }) + '\n');
        });
        conn.on('data', d => { buf += d.toString(); });
        setTimeout(() => { conn.destroy(); resolve(buf); }, ms);
      });
    }

    it('replays full scrollback with colors, no forced alt screen', async () => {
      const res = await sendCmd({
        cmd: 'spawn',
        name: 'att-shell',
        args: {
          cmd: 'bash',
          args: ['-c', 'for i in $(seq 1 200); do printf "\\033[31mline-%03d\\033[0m\\n" "$i"; done; sleep 5'],
        },
      });
      expect(res.ok).toBe(true);
      await new Promise(r => setTimeout(r, 1200));

      const data = await attachCollect('att-shell');
      const nl = data.indexOf('\n');
      const ack = JSON.parse(data.slice(0, nl));
      expect(ack.ok).toBe(true);
      expect(ack.mode).toBe('attach');
      expect(ack.alt).toBe(false);

      const replay = data.slice(nl + 1);
      // full history, including lines far above the visible screen
      expect(replay).toContain('line-001');
      expect(replay).toContain('line-200');
      // ANSI colors preserved
      expect(replay).toMatch(/\x1b\[[0-9;]*m/);
      // normal-buffer session must not push the client into the alt screen
      expect(replay).not.toContain('\x1b[?1049h');
    }, 15000);

    it('replays alt-screen TUIs with the alt-screen switch', async () => {
      const res = await sendCmd({
        cmd: 'spawn',
        name: 'att-tui',
        args: { cmd: 'less', args: ['/etc/hosts'] },
      });
      expect(res.ok).toBe(true);
      await new Promise(r => setTimeout(r, 1200));

      const data = await attachCollect('att-tui');
      const nl = data.indexOf('\n');
      const ack = JSON.parse(data.slice(0, nl));
      expect(ack.ok).toBe(true);
      expect(ack.alt).toBe(true);

      const replay = data.slice(nl + 1);
      expect(replay).toContain('\x1b[?1049h');
      expect(replay).toContain('localhost');
    }, 15000);

    it('sizes the session to the attaching client', async () => {
      // A client that sends its terminal size in the attach request resizes the
      // session (and its child's winsize) to match — the fix for the flickering
      // status line and missing bottom row when a session is taller/wider than
      // the pane it is viewed in.
      const spawn = await sendCmd({ cmd: 'spawn', name: 'att-resize', args: { cmd: 'zsh' } });
      expect(spawn.ok).toBe(true);
      await new Promise(r => setTimeout(r, 300));

      const data = await new Promise((resolve, reject) => {
        const conn = createConnection(SOCKET_PATH);
        let buf = '';
        conn.on('error', reject);
        conn.on('connect', () => {
          conn.write(JSON.stringify({ cmd: 'attach', name: 'att-resize', cols: 77, rows: 25 }) + '\n');
        });
        conn.on('data', d => { buf += d.toString(); });
        setTimeout(() => { conn.destroy(); resolve(buf); }, 600);
      });
      const ack = JSON.parse(data.slice(0, data.indexOf('\n')));
      expect(ack.ok).toBe(true);
      expect(ack.cols).toBe(77);
      expect(ack.rows).toBe(25);

      // the resize sticks on the session after the client detaches
      const info = await sendCmd({ cmd: 'info', name: 'att-resize' });
      expect(info.ok).toBe(true);
      expect(info.info.terminalSize).toBe('77x25');
    }, 15000);

    it('leaves the session size unchanged when the client sends no size', async () => {
      const spawn = await sendCmd({
        cmd: 'spawn', name: 'att-nosize', args: { cmd: 'zsh', cols: 90, rows: 20 },
      });
      expect(spawn.ok).toBe(true);
      await new Promise(r => setTimeout(r, 300));

      await attachCollect('att-nosize', 500);
      const info = await sendCmd({ cmd: 'info', name: 'att-nosize' });
      expect(info.ok).toBe(true);
      expect(info.info.terminalSize).toBe('90x20');
    }, 15000);
  });

  describe('config', () => {
    it('sets screen size config', async () => {
      const res = await sendCmd({
        cmd: 'config',
        args: { key: 'screen', value: '120x40' },
      });
      expect(res.ok).toBe(true);
    });

    it('sets cap-on-send config', async () => {
      const res = await sendCmd({
        cmd: 'config',
        args: { key: 'cap-on-send', value: 'on' },
      });
      expect(res.ok).toBe(true);
    });
  });

  describe('status', () => {
    it('returns daemon status with uptime', async () => {
      const res = await sendCmd({ cmd: 'status' });
      expect(res.ok).toBe(true);
      expect(res.status).toBeDefined();
      expect(typeof res.status.uptimeMs).toBe('number');
      expect(typeof res.status.sessions.total).toBe('number');
    });
  });
});
