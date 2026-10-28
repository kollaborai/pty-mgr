import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { removeIfIdentityTo } from '../lib/pty-manager.mjs';

const buildDir = mkdtempSync('/tmp/pty-build-');
const compiled = join(buildDir, 'pty-mgr');
const modes = [
  ['javascript', ['bun', resolve('lib/pty-manager.mjs')]],
  ['compiled', [compiled]],
];
const oldBinary = process.env.PTY_MGR_LEGACY_BINARY;
const delay = ms => new Promise(r => setTimeout(r, ms));

beforeAll(async () => {
  const build = Bun.spawn(['bun', 'build', 'bin/pty-mgr.mjs', '--compile', '--outfile', compiled], { stdout: 'pipe', stderr: 'pipe' });
  if (await build.exited !== 0) throw new Error(await new Response(build.stderr).text());
  if (process.platform === 'darwin') {
    const sign = Bun.spawn(['codesign', '--force', '--sign', '-', compiled], { stdout: 'ignore', stderr: 'pipe' });
    if (await sign.exited !== 0) throw new Error(await new Response(sign.stderr).text());
  }
}, 30000);
afterAll(() => { if (existsSync(compiled)) unlinkSync(compiled); rmdirSync(buildDir); });

function request(socket, req) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socket);
    let buf = '';
    conn.on('error', reject);
    conn.on('connect', () => conn.write(JSON.stringify(req) + '\n'));
    conn.on('data', data => {
      buf += data.toString();
      const end = buf.indexOf('\n');
      if (end >= 0) { conn.end(); resolve(JSON.parse(buf.slice(0, end))); }
    });
    conn.on('end', () => { if (!buf.includes('\n')) reject(new Error('response interrupted')); });
  });
}

async function scratch(command, run) {
  const home = mkdtempSync('/tmp/pty-id-');
  const socket = join(home, '.pty-manager', 'scratch.sock');
  const env = { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', __PTY_DAEMON_CHILD: '1' };
  let proc;
  async function start() {
    proc = Bun.spawn([...command, '@scratch', 'daemon'], { env, stdout: 'ignore', stderr: 'pipe' });
    for (let i = 0; i < 100 && !existsSync(socket); i++) await delay(30);
    if (!existsSync(socket)) throw new Error('scratch socket did not appear');
    await request(socket, { cmd: 'status' });
  }
  async function stop() {
    if (!proc) return;
    try { await request(socket, { cmd: 'stop' }); } catch {}
    await Promise.race([proc.exited, delay(2000)]);
    if (proc.exitCode === null) { proc.kill(); await proc.exited; }
    proc = null;
    if (existsSync(socket)) unlinkSync(socket);
  }
  try { await start(); await run({ socket, env, start, stop }); }
  finally {
    await stop();
    const dir = join(home, '.pty-manager');
    if (existsSync(dir)) rmdirSync(dir);
    rmdirSync(home);
  }
}

const spawn = (socket, name, cmd = '/bin/sleep', args = ['60']) => request(socket, { cmd: 'spawn', name, args: { cmd, args } });
const remove = (socket, name, token) => request(socket, { cmd: 'remove-if-identity', name, args: { daemonId: token.daemonId, sessionId: token.sessionId } });
async function waitExit(socket, name) {
  for (let i = 0; i < 100; i++) {
    const res = await request(socket, { cmd: 'info', name });
    if (!res.info.alive) return;
    await delay(20);
  }
  throw new Error('session did not exit');
}

for (const [label, command] of modes) describe(`${label} identity protocol`, () => {
  it('rejects a token from list and info after a same-name successor appears', async () => {
    await scratch(command, async ({ socket }) => {
      const first = await spawn(socket, 'observed', '/bin/sh', ['-c', 'exit 0']);
      const listed = (await request(socket, { cmd: 'list' })).sessions.find(s => s.name === 'observed');
      const info = (await request(socket, { cmd: 'info', name: 'observed' })).info;
      await waitExit(socket, 'observed');
      const next = await spawn(socket, 'observed');
      expect(next.sessionId).not.toBe(first.sessionId);
      for (const token of [listed, info]) expect((await remove(socket, 'observed', token)).code).toBe('STALE_IDENTITY');
      expect((await request(socket, { cmd: 'info', name: 'observed' })).info.sessionId).toBe(next.sessionId);
    });
  }, 30000);
  it('rejects a token from a prior daemon incarnation', async () => {
    await scratch(command, async ({ socket, stop, start }) => {
      const first = await spawn(socket, 'restart');
      await stop(); await start();
      const next = await spawn(socket, 'restart');
      expect(next.daemonId).not.toBe(first.daemonId);
      expect((await remove(socket, 'restart', first)).code).toBe('STALE_IDENTITY');
      expect((await request(socket, { cmd: 'info', name: 'restart' })).info.sessionId).toBe(next.sessionId);
    });
  }, 30000);
  it('preserves a successor through concurrent spawn and removal and an interrupted-response retry', async () => {
    await scratch(command, async ({ socket }) => {
      const first = await spawn(socket, 'race', '/bin/sh', ['-c', 'exit 0']);
      await waitExit(socket, 'race');
      const [removed, next] = await Promise.all([remove(socket, 'race', first), spawn(socket, 'race')]);
      expect(next.ok).toBe(true);
      expect(removed.ok || removed.code === 'STALE_IDENTITY').toBe(true);
      expect((await request(socket, { cmd: 'info', name: 'race' })).info.sessionId).toBe(next.sessionId);
      await new Promise((resolve, reject) => {
        const conn = createConnection(socket);
        conn.on('error', reject);
        conn.on('connect', () => conn.end(JSON.stringify({ cmd: 'remove-if-identity', name: 'race', args: { daemonId: next.daemonId, sessionId: next.sessionId } }) + '\n', resolve));
      });
      for (let i = 0; i < 100; i++) { if (!(await request(socket, { cmd: 'has', name: 'race' })).exists) break; await delay(20); }
      expect((await request(socket, { cmd: 'has', name: 'race' })).exists).toBe(false);
      const successor = await spawn(socket, 'race');
      expect((await remove(socket, 'race', next)).code).toBe('STALE_IDENTITY');
      expect((await request(socket, { cmd: 'info', name: 'race' })).info.sessionId).toBe(successor.sessionId);
    });
  }, 30000);
  it('protects replacements, retries, concurrent requests, restarts and legacy removal', async () => {
    await scratch(command, async ({ socket, start, stop }) => {
      const first = await spawn(socket, 'same', '/bin/sh', ['-c', 'exit 0']);
      expect(first.ok).toBe(true);
      expect(first.daemonId).toBeTruthy(); expect(first.sessionId).toBeTruthy();
      const listed = (await request(socket, { cmd: 'list' })).sessions[0];
      const info = (await request(socket, { cmd: 'info', name: 'same' })).info;
      expect([listed.daemonId, listed.sessionId]).toEqual([first.daemonId, first.sessionId]);
      expect([info.daemonId, info.sessionId]).toEqual([first.daemonId, first.sessionId]);
      await waitExit(socket, 'same');
      const successor = await spawn(socket, 'same');
      expect(successor.sessionId).not.toBe(first.sessionId);
      for (const token of [first, listed, info]) expect((await remove(socket, 'same', token)).code).toBe('STALE_IDENTITY');
      expect((await request(socket, { cmd: 'info', name: 'same' })).info.sessionId).toBe(successor.sessionId);
      expect((await remove(socket, 'same*', successor)).ok).toBe(false);
      const results = await Promise.all([remove(socket, 'same', successor), remove(socket, 'same', successor)]);
      expect(results.filter(r => r.ok)).toHaveLength(1);
      expect(results.find(r => !r.ok).code).toBe('NOT_FOUND');
      const third = await spawn(socket, 'same');
      expect((await remove(socket, 'same', successor)).code).toBe('STALE_IDENTITY');
      // Deliver a request and disconnect before reading its response.
      await new Promise((resolve, reject) => {
        const conn = createConnection(socket);
        conn.on('error', reject);
        conn.on('connect', () => conn.end(JSON.stringify({ cmd: 'remove-if-identity', name: 'same', args: { daemonId: third.daemonId, sessionId: third.sessionId } }) + '\n', resolve));
      });
      for (let i = 0; i < 100; i++) { if (!(await request(socket, { cmd: 'has', name: 'same' })).exists) break; await delay(20); }
      expect((await request(socket, { cmd: 'has', name: 'same' })).exists).toBe(false);
      const fourth = await spawn(socket, 'same');
      expect((await remove(socket, 'same', third)).code).toBe('STALE_IDENTITY');
      expect((await request(socket, { cmd: 'info', name: 'same' })).info.sessionId).toBe(fourth.sessionId);
      await stop(); await start();
      const afterRestart = await spawn(socket, 'same');
      expect(afterRestart.daemonId).not.toBe(fourth.daemonId);
      expect((await remove(socket, 'same', fourth)).code).toBe('STALE_IDENTITY');
      expect((await request(socket, { cmd: 'remove', name: 'same' })).ok).toBe(true);
      expect((await remove(socket, 'same', afterRestart)).code).toBe('NOT_FOUND');
      const exiting = await spawn(socket, 'race', '/bin/sh', ['-c', 'exit 0']);
      await waitExit(socket, 'race');
      const [removed, replacement] = await Promise.all([remove(socket, 'race', exiting), spawn(socket, 'race')]);
      expect(replacement.ok).toBe(true);
      expect(removed.ok || removed.code === 'STALE_IDENTITY').toBe(true);
      expect((await request(socket, { cmd: 'info', name: 'race' })).info.sessionId).toBe(replacement.sessionId);
      expect((await remove(socket, 'race', exiting)).code).toBe('STALE_IDENTITY');
      expect((await remove(socket, 'race', { daemonId: '', sessionId: '' })).code).toBe('INVALID_IDENTITY');
    });
  }, 30000);
});

it('reports unsupported and uncertain responses without name-only fallback', async () => {
  const dir = mkdtempSync('/tmp/pty-old-');
  const socket = join(dir, 'old.sock');
  const commands = [];
  const server = createServer(conn => conn.once('data', data => {
    commands.push(JSON.parse(data.toString()).cmd);
    conn.end(JSON.stringify({ ok: false, error: 'unknown command: remove-if-identity' }) + '\n');
  }));
  await new Promise(resolve => server.listen(socket, resolve));
  try {
    expect((await removeIfIdentityTo(socket, 'old', 'x', 'y')).code).toBe('UNSUPPORTED');
    expect(commands).toEqual(['remove-if-identity']);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (existsSync(socket)) unlinkSync(socket);
    rmdirSync(dir);
  }
  expect((await removeIfIdentityTo('/tmp/no-pty-identity-socket', 'old', 'x', 'y')).code).toBe('OUTCOME_UNKNOWN');
});

it.skipIf(!oldBinary || !existsSync(oldBinary))('fails closed against an installed older daemon', async () => {
  await scratch([oldBinary], async ({ socket, env }) => {
    const old = await spawn(socket, 'old');
    expect(old.ok).toBe(true);
    expect((await removeIfIdentityTo(socket, 'old', 'x', 'y')).code).toBe('UNSUPPORTED');
    expect((await request(socket, { cmd: 'info', name: 'old' })).info.alive).toBe(true);
    for (const [, command] of modes) {
      const cli = Bun.spawn([...command, '@scratch', 'remove-if-identity', 'old', 'x', 'y'], { env, stdout: 'pipe', stderr: 'pipe' });
      expect(await cli.exited).not.toBe(0);
      expect(await new Response(cli.stderr).text()).toContain('UNSUPPORTED');
    }
    expect((await request(socket, { cmd: 'info', name: 'old' })).info.alive).toBe(true);
  });
}, 30000);
