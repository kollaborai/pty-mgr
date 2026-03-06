import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { realpathSync } from 'fs';
import { join } from 'path';

const BIN_PATH = realpathSync(join(import.meta.dir, '..', 'bin', 'pty-mgr'));
const DAEMON_NAME = `@test-cli-${Date.now()}`;
const DAEMON_SOCK = join(process.env.HOME, '.pty-manager', `${DAEMON_NAME.slice(1)}.sock`);

function run(...args) {
  const proc = Bun.spawnSync(['bun', BIN_PATH, ...args], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
    exitCode: proc.exitCode,
  };
}

function runDaemon(...args) {
  return run(DAEMON_NAME, ...args);
}

async function waitForSocket(ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const { existsSync } = await import('fs');
      if (existsSync(DAEMON_SOCK)) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

describe('cli: version', () => {
  it('run("-v") outputs "1.1.2"', () => {
    const r = run('-v');
    expect(r.stdout).toBe('1.1.2');
    expect(r.exitCode).toBe(0);
  });

  it('run("--version") outputs "1.1.2"', () => {
    const r = run('--version');
    expect(r.stdout).toBe('1.1.2');
    expect(r.exitCode).toBe(0);
  });

  it('run("version") outputs "1.1.2"', () => {
    const r = run('version');
    expect(r.stdout).toBe('1.1.2');
    expect(r.exitCode).toBe(0);
  });
});

describe('cli: help', () => {
  function assertHelp(r) {
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('usage:');
  }

  it('run("-h") contains "usage:" (exit 0)', () => {
    assertHelp(run('-h'));
  });

  it('run("--help") contains "usage:" (exit 0)', () => {
    assertHelp(run('--help'));
  });

  it('run("help") shows help (exit 1, not a command)', () => {
    const r = run('help');
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toLowerCase()).toContain('usage:');
  });
});

describe('cli: no daemon error', () => {
  it('running commands without daemon shows "daemon not running"', () => {
    const r = run('@nonexistent-12345', 'list');
    expect(r.stderr.toLowerCase()).toContain('daemon not running');
  });
});

describe('cli: with daemon', () => {
  let daemonProc;

  beforeAll(async () => {
    daemonProc = Bun.spawn(['bun', BIN_PATH, 'daemon', DAEMON_NAME], {
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
    await waitForSocket();
  }, 5000);

  describe('spawn output', () => {
    it('spawn outputs: "name  pid=XXXX"', () => {
      const r = runDaemon('spawn', 'test-version', 'echo', 'hi');
      expect(r.stdout).toMatch(/^test-version\s+pid=\d+$/);
    });
  });

  describe('wrap output', () => {
    it('wrap outputs: "name-N  pid=XXXX" (cwd name + increment)', () => {
      runDaemon('remove', 'all');
      const r = runDaemon('wrap', 'echo', 'hi');
      expect(r.stdout).toMatch(/^pty-mgr-1\s+pid=\d+$/);
      runDaemon('remove', 'pty-mgr*');
    });
  });

  describe('list output', () => {
    it('when no sessions, outputs "no sessions"', () => {
      runDaemon('remove', 'all');
      const r = runDaemon('list');
      expect(r.stdout.toLowerCase()).toContain('no sessions');
    });

    it('with sessions, outputs formatted list', () => {
      runDaemon('spawn', 'test-list-1', 'echo', 'one');
      runDaemon('spawn', 'test-list-2', 'echo', 'two');
      const r = runDaemon('list');
      expect(r.stdout).toContain('test-list-1');
      expect(r.stdout).toContain('test-list-2');
      runDaemon('remove', 'test-list*');
    });
  });

  describe('rename output', () => {
    it('outputs "renamed: old -> new"', () => {
      runDaemon('spawn', 'old-name', 'echo', 'hi');
      const r = runDaemon('rename', 'old-name', 'new-name');
      expect(r.stdout.toLowerCase()).toContain('renamed:');
      expect(r.stdout).toContain('old-name');
      expect(r.stdout).toContain('new-name');
      runDaemon('remove', 'new-name');
    });
  });

  describe('aliases', () => {
    it('"n" works same as "spawn"', () => {
      const r = runDaemon('n', 'alias-n', 'echo', 'hi');
      expect(r.stdout).toMatch(/^alias-n\s+pid=\d+$/);
      runDaemon('remove', 'alias-n');
    });

    it('"new" works same as "spawn"', () => {
      const r = runDaemon('new', 'alias-new', 'echo', 'hi');
      expect(r.stdout).toMatch(/^alias-new\s+pid=\d+$/);
      runDaemon('remove', 'alias-new');
    });

    it('"w" works same as "wrap"', () => {
      runDaemon('remove', 'pty-mgr*');
      const r = runDaemon('w', 'echo', 'hi');
      expect(r.stdout).toMatch(/^pty-mgr-\d+\s+pid=\d+$/);
      runDaemon('remove', 'pty-mgr*');
    });

    it('"s" works same as "send"', () => {
      runDaemon('spawn', 'alias-s', 'cat');
      const r = runDaemon('s', 'alias-s', 'test');
      expect(r.exitCode).toBe(0);
      runDaemon('remove', 'alias-s');
    });

    it('"c" works same as "capture"', () => {
      runDaemon('spawn', 'alias-c', 'echo', 'hi');
      const r = runDaemon('c', 'alias-c');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hi');
      runDaemon('remove', 'alias-c');
    });

    it('"cap" works same as "capture"', () => {
      runDaemon('spawn', 'alias-cap', 'echo', 'hi');
      const r = runDaemon('cap', 'alias-cap');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hi');
      runDaemon('remove', 'alias-cap');
    });

    it('"k" works same as "kill"', () => {
      runDaemon('spawn', 'alias-k', 'sleep', '10');
      const r = runDaemon('k', 'alias-k');
      expect(r.exitCode).toBe(0);
      runDaemon('remove', 'alias-k');
    });

    it('"l" works same as "list"', () => {
      runDaemon('spawn', 'alias-l', 'echo', 'hi');
      const r = runDaemon('l');
      expect(r.stdout).toContain('alias-l');
      runDaemon('remove', 'alias-l');
    });

    it('"ls" works same as "list"', () => {
      runDaemon('spawn', 'alias-ls', 'echo', 'hi');
      const r = runDaemon('ls');
      expect(r.stdout).toContain('alias-ls');
      runDaemon('remove', 'alias-ls');
    });

    it('"mv" works same as "rename"', () => {
      runDaemon('spawn', 'old-mv', 'echo', 'hi');
      const r = runDaemon('mv', 'old-mv', 'new-mv');
      expect(r.stdout.toLowerCase()).toContain('renamed:');
      runDaemon('remove', 'new-mv');
    });

    it('"ren" works same as "rename"', () => {
      runDaemon('spawn', 'old-ren', 'echo', 'hi');
      const r = runDaemon('ren', 'old-ren', 'new-ren');
      expect(r.stdout.toLowerCase()).toContain('renamed:');
      runDaemon('remove', 'new-ren');
    });

    it('"r" works same as "remove"', () => {
      runDaemon('spawn', 'alias-r', 'sleep', '10');
      const r = runDaemon('r', 'alias-r');
      expect(r.exitCode).toBe(0);
    });

    it('"rm" works same as "remove"', () => {
      runDaemon('spawn', 'alias-rm', 'sleep', '10');
      const r = runDaemon('rm', 'alias-rm');
      expect(r.exitCode).toBe(0);
    });
  });

  afterAll(() => {
    runDaemon('remove', 'all');
    runDaemon('stop');
    void daemonProc; // suppress unused lint
    daemonProc?.kill();
  });
});
