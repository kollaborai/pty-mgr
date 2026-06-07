import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const BIN_PATH = realpathSync(join(import.meta.dir, '..', 'bin', 'pty-mgr.mjs'));
const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')
).version;
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

function runWithInput(args, input, env = {}) {
  const proc = Bun.spawnSync(['bun', BIN_PATH, ...args], {
    env: { ...process.env, ...env },
    stdin: Buffer.from(input),
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
  it('run("-v") outputs the package version', () => {
    const r = run('-v');
    expect(r.stdout).toBe(PACKAGE_VERSION);
    expect(r.exitCode).toBe(0);
  });

  it('run("--version") outputs the package version', () => {
    const r = run('--version');
    expect(r.stdout).toBe(PACKAGE_VERSION);
    expect(r.exitCode).toBe(0);
  });

  it('run("version") outputs the package version', () => {
    const r = run('version');
    expect(r.stdout).toBe(PACKAGE_VERSION);
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

describe('cli: demo', () => {
  it('runs the built-in smoke demo to completion', () => {
    const r = run('demo');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('hello-from-pty');
    expect(r.stdout).toContain('MARKER_42');
    expect(r.stdout).toContain('--- demo complete ---');
  }, 10000);
});

describe('cli: flow', () => {
  it('lists configured flows from an explicit config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-mgr-flow-cli-'));
    const configPath = join(dir, 'pty-mgr.config.json');
    writeFileSync(configPath, JSON.stringify({
      adapters: {},
      flows: {
        spec: {},
        review: {},
      },
    }));

    const r = run('flow', 'list', '--config', configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split('\n')).toEqual(['spec', 'review']);
  });

  it('requires --task for flow run before starting agents', () => {
    const r = run('flow', 'run', 'spec');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('flow run requires --task <text>');
  });
});

describe('cli: setup', () => {
  it('writes selected wrappers and exits cleanly', () => {
    const home = mkdtempSync(join(tmpdir(), 'pty-mgr-setup-'));
    const rcFile = join(home, '.zshrc');
    writeFileSync(rcFile, '# test rc\n');

    const r = runWithInput(
      ['setup'],
      'y\ny\nn\nno\n',
      { HOME: home, SHELL: '/bin/zsh' },
    );

    const rc = readFileSync(rcFile, 'utf8');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`added to ${rcFile}: claude, codex`);
    expect(r.stderr).toBe('');
    expect(rc).toContain('# pty-mgr: managed claude sessions');
    expect(rc).toContain('# pty-mgr: managed codex sessions');
    expect(rc).toContain('$_p wrap command claude "$@"');
    expect(rc).toContain('$_p wrap command codex "$@"');
    expect(rc).not.toContain('# pty-mgr: managed gemini sessions');
  });

  it('generated wrappers do not attach to failed wrap output', () => {
    const home = mkdtempSync(join(tmpdir(), 'pty-mgr-wrapper-'));
    const binDir = join(home, 'bin');
    const rcFile = join(home, '.zshrc');
    const fakePtyMgr = join(binDir, 'pty-mgr');
    const fakeP = join(binDir, 'p');

    mkdirSync(binDir, { recursive: true });
    writeFileSync(rcFile, '');

    const setup = runWithInput(
      ['setup'],
      'n\ny\nn\nno\n',
      { HOME: home, SHELL: '/bin/zsh' },
    );
    expect(setup.exitCode).toBe(0);

    writeFileSync(fakePtyMgr, `#!/bin/sh
case "$1" in
  status) exit 0 ;;
  daemon) exit 0 ;;
  wrap) echo "error: unknown command: wrap" >&2; exit 1 ;;
  attach) echo "attach called: $2" >&2; exit 0 ;;
esac
exit 0
`);
    chmodSync(fakePtyMgr, 0o755);
    writeFileSync(fakeP, readFileSync(fakePtyMgr));
    chmodSync(fakeP, 0o755);

    const r = Bun.spawnSync(['zsh', '-fc', `. ${rcFile}; codex`], {
      env: {
        ...process.env,
        HOME: home,
        SHELL: '/bin/zsh',
        PATH: `${binDir}:${process.env.PATH}`,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stderr = r.stderr.toString();
    expect(r.exitCode).toBe(1);
    expect(stderr).toContain('pty-mgr: wrap failed');
    expect(stderr).toContain('daemon does not support wrap');
    expect(stderr).toContain('unknown command: wrap');
    expect(stderr).not.toContain('attach called:');
  });

  it('replaces existing generated wrappers during setup', () => {
    const home = mkdtempSync(join(tmpdir(), 'pty-mgr-update-wrapper-'));
    const rcFile = join(home, '.zshrc');
    writeFileSync(rcFile, `before
# pty-mgr: managed codex sessions
codex() {
  echo OLD_WRAPPER
}
after
`);

    const r = runWithInput(
      ['setup'],
      'n\ny\nn\nno\n',
      { HOME: home, SHELL: '/bin/zsh' },
    );

    const rc = readFileSync(rcFile, 'utf8');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`updated in ${rcFile}: codex`);
    expect(rc).toContain('before');
    expect(rc).toContain('after');
    expect(rc).not.toContain('OLD_WRAPPER');
    expect(rc).toContain('pty-mgr: wrap failed for codex');
    expect(rc).toContain('$_p wrap command codex "$@"');
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

  describe('watch output', () => {
    it('outputs "done" when bottom 100 captured lines are stable', () => {
      runDaemon('spawn', 'watch-stable', 'echo', 'stable');
      const r = runDaemon('watch', 'watch-stable', '20ms');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('done');
      runDaemon('remove', 'watch-stable');
    });

    it('outputs "working" when bottom 100 captured lines change', async () => {
      runDaemon(
        'spawn',
        'watch-changing',
        'zsh',
        '-lc',
        'i=0; while [ $i -lt 50 ]; do echo tick-$i; i=$((i+1)); sleep 0.03; done; sleep 1',
      );
      await new Promise(r => setTimeout(r, 250));
      const r = runDaemon('watch', 'watch-changing', '120ms');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('working');
      runDaemon('remove', 'watch-changing');
    });

    it('outputs "working" when any globbed session capture changes', async () => {
      runDaemon('remove', 'watch-glob-*');
      runDaemon('spawn', 'watch-glob-stable', 'echo', 'stable');
      runDaemon(
        'spawn',
        'watch-glob-changing',
        'zsh',
        '-lc',
        'i=0; while [ $i -lt 50 ]; do echo tick-$i; i=$((i+1)); sleep 0.03; done; sleep 1',
      );
      await new Promise(r => setTimeout(r, 250));
      const r = runDaemon('watch', 'watch-glob-*', '120ms');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('working');
      runDaemon('remove', 'watch-glob-*');
    });
  });

  describe('@ in payload', () => {
    it('delivers send text starting with @ (not parsed as daemon selector)', async () => {
      runDaemon('remove', 'at-payload');
      runDaemon('spawn', 'at-payload', 'cat');
      await new Promise(r => setTimeout(r, 200));
      runDaemon('send', 'at-payload', '@everyone');
      await new Promise(r => setTimeout(r, 600));
      const r = runDaemon('c', 'at-payload');
      expect(r.stdout).toContain('@everyone');
      runDaemon('remove', 'at-payload');
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
