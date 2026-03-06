import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { PtyManager } from '../lib/pty-manager.mjs';

describe('edge cases', () => {
  let mgr;

  beforeEach(() => {
    mgr = new PtyManager();
  });

  afterEach(() => {
    mgr.destroyAll();
  });

  describe('high throughput', () => {
    it('handles massive output without crashing', async () => {
      mgr.spawn('edge-throughput', 'zsh', ['-c', 'seq 1 10000']);
      await mgr.waitForExit('edge-throughput', 10000);
      const output = mgr.capture('edge-throughput');
      expect(typeof output).toBe('string');
      expect(output.length).toBeGreaterThan(0);
    }, 30000);
  });

  describe('large scrollback', () => {
    it('captures full output exceeding scrollback', async () => {
      mgr.spawn('edge-scrollback', 'zsh', ['-c', 'seq 1 6000']);
      await mgr.waitForExit('edge-scrollback', 10000);
      const full = mgr.capture('edge-scrollback');
      expect(full.length).toBeGreaterThan(0);
    }, 30000);

    it('captures tail lines from large output', async () => {
      mgr.spawn('edge-tail', 'zsh', ['-c', 'seq 1 6000']);
      await mgr.waitForExit('edge-tail', 10000);
      const tail = mgr.capture('edge-tail', 10);
      const lines = tail.split('\n').filter(l => l.trim());
      expect(lines.length).toBeLessThanOrEqual(10);
      expect(lines.length).toBeGreaterThan(0);
    }, 30000);
  });

  describe('concurrent spawns', () => {
    it('spawns 20 sessions with unique names', async () => {
      for (let i = 1; i <= 20; i++) {
        mgr.spawn(`edge-${i}`, 'zsh', ['-c', `echo session-${i}`]);
      }
      const list = mgr.list();
      expect(list.length).toBe(20);
      // wait for all to exit
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          mgr.waitForExit(`edge-${i + 1}`, 5000)
        )
      );
      mgr.destroyAll();
    }, 30000);
  });

  describe('zombie cleanup', () => {
    it('handles exited process cleanly', async () => {
      mgr.spawn('edge-zombie', 'zsh', ['-c', 'sleep 0.1']);
      await mgr.waitForExit('edge-zombie', 3000);
      expect(mgr.isAlive('edge-zombie')).toBe(false);
      const output = mgr.capture('edge-zombie');
      expect(typeof output).toBe('string');
      mgr.remove('edge-zombie');
      expect(mgr.has('edge-zombie')).toBe(false);
    }, 15000);
  });

  describe('binary output', () => {
    it('handles binary characters in output', async () => {
      mgr.spawn('edge-binary', 'zsh', ['-c', "printf '\\x00\\x01\\x02\\xff'"]);
      await mgr.waitForExit('edge-binary', 3000);
      const output = mgr.capture('edge-binary');
      expect(typeof output).toBe('string');
    }, 15000);
  });

  describe('rapid kill/spawn', () => {
    it('allows same name reuse after remove', async () => {
      mgr.spawn('test-rapid', 'zsh', ['-c', 'echo hi']);
      await mgr.waitForExit('test-rapid', 3000);
      mgr.remove('test-rapid');
      expect(mgr.has('test-rapid')).toBe(false);
      mgr.spawn('test-rapid', 'zsh');
      await new Promise(r => setTimeout(r, 300));
      mgr.sendKeys('test-rapid', 'echo again\r');
      await new Promise(r => setTimeout(r, 500));
      expect(mgr.has('test-rapid')).toBe(true);
      expect(mgr.capture('test-rapid')).toContain('again');
    }, 15000);
  });

  describe('ctrl-c handling', () => {
    it('interrupts long running command', async () => {
      mgr.spawn('edge-ctrlc', 'zsh');
      await new Promise(r => setTimeout(r, 300));
      mgr.sendKeys('edge-ctrlc', 'sleep 100\r');
      await new Promise(r => setTimeout(r, 300));
      mgr.sendKeys('edge-ctrlc', '\x03');
      await new Promise(r => setTimeout(r, 500));
      const output = mgr.capture('edge-ctrlc');
      expect(output.length).toBeGreaterThan(0);
    }, 15000);
  });

  describe('empty capture', () => {
    it('returns string for new session', async () => {
      mgr.spawn('edge-empty', 'zsh');
      await new Promise(r => setTimeout(r, 200));
      const output = mgr.capture('edge-empty');
      expect(typeof output).toBe('string');
    }, 15000);
  });

  describe('duplicate spawn', () => {
    it('throws on duplicate name', () => {
      mgr.spawn('edge-dup', 'zsh');
      expect(() => mgr.spawn('edge-dup', 'zsh')).toThrow();
    }, 15000);
  });

  describe('waitFor timeout', () => {
    it('rejects on timeout', async () => {
      mgr.spawn('edge-timeout', 'zsh');
      try {
        await mgr.waitFor('edge-timeout', /NEVER_MATCH_xyz123/, 1000);
        throw new Error('should have timed out');
      } catch (e) {
        expect(e.message).toContain('timeout');
      }
    }, 15000);
  });
});
