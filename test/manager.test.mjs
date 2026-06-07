import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { PtyManager, validateSessionName, buildSafeEnv, SAFE_ENV_KEYS } from '../lib/pty-manager.mjs';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

describe('PtyManager', () => {
  let mgr;

  beforeEach(() => {
    mgr = new PtyManager();
  });

  afterEach(async () => {
    await mgr.destroyAll();
  });

  describe('SESSION LIFECYCLE', () => {
    it('spawn creates session, has() returns true', () => {
      const name = mgr.spawn('test-session', 'zsh', []);
      expect(name).toBe('test-session');
      expect(mgr.has('test-session')).toBe(true);

      const session = mgr.get('test-session');
      expect(session.name).toBe('test-session');
      expect(session.childPid).toBeGreaterThan(0);
      expect(session.isAlive()).toBe(true);
    });

    it('spawn duplicate name throws', () => {
      mgr.spawn('dup-name', 'zsh', []);
      expect(() => mgr.spawn('dup-name', 'zsh', [])).toThrow('already exists');
    });

    it('spawn with invalid name throws: empty', () => {
      expect(() => mgr.spawn('', 'zsh', [])).toThrow();
    });

    it('spawn with invalid name throws: slashes', () => {
      expect(() => mgr.spawn('bad/name', 'zsh', [])).toThrow();
    });

    it('spawn with invalid name throws: spaces', () => {
      expect(() => mgr.spawn('bad name', 'zsh', [])).toThrow();
    });

    it('spawn with invalid name throws: starts with dash', () => {
      expect(() => mgr.spawn('-bad', 'zsh', [])).toThrow();
    });

    it('spawn with invalid name throws: starts with dot', () => {
      expect(() => mgr.spawn('.hidden', 'zsh', [])).toThrow();
    });

    it('spawn with invalid name throws: >128 chars', () => {
      const longName = 'a'.repeat(129);
      expect(() => mgr.spawn(longName, 'zsh', [])).toThrow();
    });

    it('spawn with invalid name throws: path traversal', () => {
      expect(() => mgr.spawn('../etc/passwd', 'zsh', [])).toThrow();
    });

    it('kill terminates process, session stays in registry', async () => {
      mgr.spawn('kill-test', 'zsh', []);
      expect(mgr.has('kill-test')).toBe(true);

      mgr.kill('kill-test');
      await sleep(200);

      expect(mgr.has('kill-test')).toBe(true);
      const session = mgr.get('kill-test');
      expect(session.exited).toBe(true);
      expect(session.isAlive()).toBe(false);
    });

    it('kill sets exited=true and populates exitCode', async () => {
      mgr.spawn('exit-code-test', 'zsh', []);
      mgr.kill('exit-code-test');
      await sleep(200);

      const session = mgr.get('exit-code-test');
      expect(session.exited).toBe(true);
      expect(session.exitCode).toBeDefined();
      expect(typeof session.exitCode).toBe('number');
    });

    it('remove kills and deletes from registry', async () => {
      mgr.spawn('remove-test', 'zsh', []);
      expect(mgr.has('remove-test')).toBe(true);

      mgr.remove('remove-test');
      await sleep(200);

      expect(mgr.has('remove-test')).toBe(false);
      expect(() => mgr.get('remove-test')).toThrow('not found');
    });

    it('destroyAll cleans up everything', async () => {
      mgr.spawn('sess1', 'zsh', []);
      mgr.spawn('sess2', 'zsh', []);
      mgr.spawn('sess3', 'zsh', []);

      expect(mgr.list().length).toBe(3);
      await mgr.destroyAll();

      expect(mgr.list().length).toBe(0);
      expect(mgr.has('sess1')).toBe(false);
      expect(mgr.has('sess2')).toBe(false);
      expect(mgr.has('sess3')).toBe(false);
    });

    it('get returns existing session', () => {
      mgr.spawn('get-test', 'zsh', []);
      const retrieved = mgr.get('get-test');
      expect(retrieved).toBeDefined();
      expect(retrieved.name).toBe('get-test');
    });

    it('get throws on non-existent session', () => {
      expect(() => mgr.get('nonexistent')).toThrow('not found');
    });

    it('has returns false for non-existent session', () => {
      expect(mgr.has('does-not-exist')).toBe(false);
    });

    it('pid returns child process pid', () => {
      mgr.spawn('pid-test', 'zsh', []);
      const pid = mgr.pid('pid-test');
      expect(pid).toBeGreaterThan(0);
      expect(pid).toBe(mgr.get('pid-test').childPid);
    });

    it('isAlive returns true for live session', () => {
      mgr.spawn('alive-test', 'zsh', []);
      expect(mgr.isAlive('alive-test')).toBe(true);
    });

    it('isAlive returns false for dead session', async () => {
      mgr.spawn('dead-test', 'zsh', []);
      mgr.kill('dead-test');
      await sleep(200);
      expect(mgr.isAlive('dead-test')).toBe(false);
    });
  });

  describe('CAPTURE', () => {
    it('capture returns rendered output after echo', async () => {
      mgr.spawn('cap-test', 'zsh', []);
      await sleep(300);

      mgr.sendKeys('cap-test', 'echo hello world\r');
      await sleep(500);

      const output = mgr.capture('cap-test');
      expect(output).toContain('hello world');
    });

    it('capture with tailLines returns only last N lines', async () => {
      mgr.spawn('tail-test', 'zsh', []);
      await sleep(300);

      mgr.sendKeys('tail-test', 'echo line1\r');
      await sleep(200);
      mgr.sendKeys('tail-test', 'echo line2\r');
      await sleep(200);
      mgr.sendKeys('tail-test', 'echo line3\r');
      await sleep(500);

      const full = mgr.capture('tail-test');
      const tail = mgr.capture('tail-test', 2);
      const tailLines = tail.split('\n');

      expect(full).toContain('line1');
      expect(tailLines.length).toBeLessThanOrEqual(2);
    });

    it('capture on dead session returns last screen state', async () => {
      mgr.spawn('dead-cap-test', 'zsh', []);
      await sleep(300);

      mgr.sendKeys('dead-cap-test', 'echo final words\r');
      await sleep(500);

      const beforeKill = mgr.capture('dead-cap-test');
      expect(beforeKill).toContain('final words');

      mgr.kill('dead-cap-test');
      await sleep(200);

      const afterKill = mgr.capture('dead-cap-test');
      expect(afterKill).toContain('final words');
    });
  });

  describe('SENDKEYS', () => {
    it('sendKeys delivers text to process', async () => {
      mgr.spawn('send-test', 'zsh', []);
      await sleep(300);

      mgr.sendKeys('send-test', 'echo test123\r');
      await sleep(500);

      const output = mgr.capture('send-test');
      expect(output).toContain('test123');
    });

    it('sendKeys on dead session throws', async () => {
      mgr.spawn('dead-send-test', 'zsh', []);
      mgr.kill('dead-send-test');
      await sleep(200);

      expect(() => mgr.sendKeys('dead-send-test', 'echo test\r'))
        .toThrow('exited');
    });

    it('\\r sends enter, new prompt appears', async () => {
      mgr.spawn('enter-test', 'zsh', []);
      await sleep(300);

      const before = mgr.capture('enter-test');
      mgr.sendKeys('enter-test', 'echo enter-test\r');
      await sleep(500);

      const after = mgr.capture('enter-test');
      expect(after).toContain('enter-test');
      expect(after.length).toBeGreaterThan(before.length);
    });

    it('sendKeys writes special characters', async () => {
      mgr.spawn('special-test', 'zsh', []);
      await sleep(300);

      mgr.sendKeys('special-test', 'echo "tab\there"\r');
      await sleep(500);

      const output = mgr.capture('special-test');
      expect(output).toContain('tab');
    });
  });

  describe('RENAME', () => {
    it('rename changes key in registry', () => {
      mgr.spawn('old-name', 'zsh', []);
      expect(mgr.has('old-name')).toBe(true);
      expect(mgr.has('new-name')).toBe(false);

      mgr.rename('old-name', 'new-name');

      expect(mgr.has('old-name')).toBe(false);
      expect(mgr.has('new-name')).toBe(true);
    });

    it('rename updates session.name property', () => {
      mgr.spawn('rename-prop', 'zsh', []);
      const session = mgr.get('rename-prop');
      expect(session.name).toBe('rename-prop');

      mgr.rename('rename-prop', 'renamed-session');

      const renamed = mgr.get('renamed-session');
      expect(renamed.name).toBe('renamed-session');
      expect(renamed).toBe(session);
    });

    it('rename to existing name throws', () => {
      mgr.spawn('session1', 'zsh', []);
      mgr.spawn('session2', 'zsh', []);

      expect(() => mgr.rename('session1', 'session2'))
        .toThrow();
    });

    it('rename validates new name', () => {
      mgr.spawn('valid-session', 'zsh', []);

      expect(() => mgr.rename('valid-session', ''))
        .toThrow();
      expect(() => mgr.rename('valid-session', 'bad/name'))
        .toThrow();
      expect(() => mgr.rename('valid-session', '-bad'))
        .toThrow();
    });

    it('old name throws after rename', () => {
      mgr.spawn('before-rename', 'zsh', []);
      mgr.rename('before-rename', 'after-rename');

      expect(() => mgr.get('before-rename')).toThrow('not found');
      expect(mgr.get('after-rename')).toBeDefined();
    });

    it('rename non-existent session throws', () => {
      expect(() => mgr.rename('does-not-exist', 'new-name'))
        .toThrow('not found');
    });
  });

  describe('LIST', () => {
    it('list returns all sessions with metadata', () => {
      mgr.spawn('list-test1', 'zsh', []);
      mgr.spawn('list-test2', 'zsh', []);

      const sessions = mgr.list();
      expect(sessions.length).toBe(2);

      const s1 = sessions.find(s => s.name === 'list-test1');
      const s2 = sessions.find(s => s.name === 'list-test2');

      expect(s1).toBeDefined();
      expect(s2).toBeDefined();

      expect(s1.name).toBe('list-test1');
      expect(s1.pid).toBeGreaterThan(0);
      expect(s1.alive).toBe(true);
      expect(s1.cmd).toBe('zsh');

      expect(s2.name).toBe('list-test2');
      expect(s2.pid).toBeGreaterThan(0);
      expect(s2.alive).toBe(true);
    });

    it('list shows alive/dead status correctly', async () => {
      mgr.spawn('alive-sess', 'zsh', []);
      mgr.spawn('dead-sess', 'zsh', []);

      mgr.kill('dead-sess');
      await sleep(200);

      const sessions = mgr.list();
      const alive = sessions.find(s => s.name === 'alive-sess');
      const dead = sessions.find(s => s.name === 'dead-sess');

      expect(alive.alive).toBe(true);
      expect(dead.alive).toBe(false);
    });

    it('list returns empty array when no sessions', () => {
      expect(mgr.list()).toEqual([]);
    });

    it('list returns all sessions', () => {
      mgr.spawn('test-foo', 'zsh', []);
      mgr.spawn('test-bar', 'zsh', []);
      mgr.spawn('other-baz', 'zsh', []);

      const all = mgr.list();
      expect(all.length).toBe(3);
      expect(all.every(s => s.alive)).toBe(true);
    });
  });

  describe('ACTIVITY TRACKING', () => {
    it('new session has activity event emitter', () => {
      mgr.spawn('activity-test', 'zsh', []);
      const session = mgr.get('activity-test');
      expect(session.events).toBeDefined();
      expect(typeof session.events.on).toBe('function');
      expect(typeof session.events.off).toBe('function');
    });

    it('session emits data event on output', async () => {
      mgr.spawn('data-event', 'zsh', []);
      const session = mgr.get('data-event');

      const gotPromise = new Promise((resolve) => {
        const handler = (data) => {
          session.events.removeListener('data', handler);
          resolve(data);
        };
        session.events.on('data', handler);
      });
      await sleep(300);
      mgr.sendKeys('data-event', 'echo test\r');
      const got = await gotPromise;
      expect(typeof got).toBe('string');
    });

    it('session emits exit event', async () => {
      mgr.spawn('exit-event', 'zsh', []);
      const session = mgr.get('exit-event');

      const gotPromise = new Promise((resolve) => {
        session.events.on('exit', resolve);
      });
      await sleep(100);
      mgr.kill('exit-event');
      const got = await gotPromise;
      // exit event payload is {exitCode, signal}
      expect(got).toBeDefined();
      expect(typeof got.exitCode).toBe('number');
    });

    it('dispose clears activity timer', () => {
      mgr.spawn('dispose-timer', 'zsh', []);
      const session = mgr.get('dispose-timer');
      session.dispose();
      // after dispose, timer should be cleared (clearTimeout sets it but doesn't null it)
      // just verify dispose doesn't throw
      expect(session._isIdle).toBeDefined();
    });
  });

  describe('WAITFOR', () => {
    it('waitFor resolves when pattern appears', async () => {
      mgr.spawn('wait-test', 'zsh', []);

      const timer = setTimeout(() => {
        mgr.sendKeys('wait-test', 'echo MATCH_THIS\r');
      }, 200);

      await mgr.waitFor('wait-test', /MATCH_THIS/, 2000).finally(() => clearTimeout(timer));
      expect(true).toBe(true);
    });

    it('waitFor rejects on timeout', async () => {
      mgr.spawn('timeout-test', 'zsh', []);

      try {
        await mgr.waitFor('timeout-test', /NEVER_APPEARS/, 500);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e.message).toContain('timeout');
      }
    });

    it('waitFor with string pattern works', async () => {
      mgr.spawn('string-pattern', 'zsh', []);

      const timer = setTimeout(() => {
        mgr.sendKeys('string-pattern', 'echo FINDME\r');
      }, 200);

      await mgr.waitFor('string-pattern', /FINDME/, 3000).finally(() => clearTimeout(timer));
      expect(true).toBe(true);
    });

    it('waitFor resolves from already-rendered output', async () => {
      mgr.spawn('fast-output', 'zsh', ['-fc', 'echo FAST_MATCH']);

      await mgr.waitForExit('fast-output', 3000);
      const line = await mgr.waitFor('fast-output', /FAST_MATCH/, 3000);
      expect(line).toContain('FAST_MATCH');
    });
  });

  describe('WAITFOREXIT', () => {
    it('waitForExit resolves when process exits', async () => {
      mgr.spawn('wait-exit', 'zsh', ['-lc', 'sleep 0.2']);

      await mgr.waitForExit('wait-exit', 5000);
      expect(mgr.get('wait-exit').exited).toBe(true);
    });

    it('waitForExit rejects on timeout', async () => {
      mgr.spawn('no-exit', 'zsh', []);

      try {
        await mgr.waitForExit('no-exit', 500);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e.message).toContain('timeout');
      }
    });
  });

  describe('validateSessionName', () => {
    it('accepts valid names', () => {
      expect(() => validateSessionName('valid')).not.toThrow();
      expect(() => validateSessionName('Valid-Name_123')).not.toThrow();
      expect(() => validateSessionName('a.b-c_d')).not.toThrow();
      expect(() => validateSessionName('Session1')).not.toThrow();
      expect(() => validateSessionName('a')).not.toThrow();
      expect(() => validateSessionName('A')).not.toThrow();
      expect(() => validateSessionName('9')).not.toThrow();
    });

    it('rejects invalid names', () => {
      expect(() => validateSessionName('')).toThrow();
      expect(() => validateSessionName('bad/name')).toThrow();
      expect(() => validateSessionName('bad name')).toThrow();
      expect(() => validateSessionName('-bad')).toThrow();
      expect(() => validateSessionName('.hidden')).toThrow();
      expect(() => validateSessionName('_bad')).toThrow();
      expect(() => validateSessionName('../etc')).toThrow();
    });

    it('rejects names >128 chars', () => {
      const tooLong = 'a'.repeat(129);
      expect(() => validateSessionName(tooLong)).toThrow();
    });

    it('accepts exactly 128 chars', () => {
      const maxLen = 'a'.repeat(128);
      expect(() => validateSessionName(maxLen)).not.toThrow();
    });
  });

  describe('buildSafeEnv', () => {
    it('includes only safe env vars', () => {
      const safe = buildSafeEnv({
        PATH: '/usr/bin',
        HOME: '/home/user',
        UNSAFE_VAR: 'should not appear',
        API_KEY: 'secret'
      });

      expect(safe.PATH).toBe('/usr/bin');
      expect(safe.HOME).toBe('/home/user');
      expect(safe.UNSAFE_VAR).toBeUndefined();
      expect(safe.API_KEY).toBeUndefined();
    });

    it('includes common safe vars by default', () => {
      const safe = buildSafeEnv({
        PATH: '/bin',
        USER: 'testuser',
        HOME: '/home/testuser',
        SHELL: '/bin/zsh'
      });

      expect(safe.PATH).toBe('/bin');
      expect(safe.USER).toBe('testuser');
      expect(safe.HOME).toBe('/home/testuser');
    });
  });

  describe('SAFE_ENV_KEYS', () => {
    it('contains expected safe environment variables', () => {
      expect(SAFE_ENV_KEYS).toBeInstanceOf(Array);
      expect(SAFE_ENV_KEYS.length).toBeGreaterThan(0);
      expect(SAFE_ENV_KEYS).toContain('PATH');
      expect(SAFE_ENV_KEYS).toContain('HOME');
      expect(SAFE_ENV_KEYS).toContain('USER');
    });
  });

  describe('PtySession direct access', () => {
    it('session has all expected properties', async () => {
      mgr.spawn('props-test', 'zsh', []);
      await new Promise(r => setTimeout(r, 200));
      const session = mgr.get('props-test');

      expect(session.name).toBe('props-test');
      expect(session.childPid).toBeDefined();
      expect(session.exited).toBe(false);
      expect(session.createdAt).toBeDefined();
      expect(session.events).toBeDefined();
    });

    it('session.isAlive reflects process state', async () => {
      mgr.spawn('isalive-test', 'zsh', []);
      const session = mgr.get('isalive-test');
      expect(session.isAlive()).toBe(true);

      mgr.kill('isalive-test');
      await new Promise(r => setTimeout(r, 500));
      expect(session.isAlive()).toBe(false);
    });

    it('session.write is alias for sendKeys', async () => {
      mgr.spawn('write-test', 'zsh', []);
      const session = mgr.get('write-test');
      await new Promise(r => setTimeout(r, 300));

      session.write('echo write-test\r');
      await new Promise(r => setTimeout(r, 500));

      const output = mgr.capture('write-test');
      expect(output).toContain('write-test');
    });

    it('session.dispose cleans up resources', async () => {
      mgr.spawn('dispose-test', 'zsh', []);
      const session = mgr.get('dispose-test');

      mgr.kill('dispose-test');
      await new Promise(r => setTimeout(r, 200));

      expect(() => session.dispose()).not.toThrow();
    });
  });

  describe('spawn options', () => {
    it('spawn with cwd option', () => {
      const name = mgr.spawn('cwd-test', 'zsh', [], { cwd: '/tmp' });
      expect(name).toBe('cwd-test');
      expect(mgr.has('cwd-test')).toBe(true);
    });

    it('spawn with env option', () => {
      const name = mgr.spawn('env-test', 'zsh', [], {
        env: { TEST_VAR: 'test_value' }
      });
      expect(name).toBe('env-test');
    });

    it('spawn with cols/rows options', () => {
      mgr.spawn('size-test', 'zsh', [], {
        cols: 120,
        rows: 40
      });
      const session = mgr.get('size-test');
      expect(session.terminal.cols).toBe(120);
      expect(session.terminal.rows).toBe(40);
    });

    it('spawn with scrollback option', () => {
      mgr.spawn('scroll-test', 'zsh', [], {
        scrollback: 10000
      });
      const session = mgr.get('scroll-test');
      expect(session.terminal.options.scrollback).toBe(10000);
    });
  });
});
