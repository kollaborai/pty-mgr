import { describe, it, expect } from "bun:test";
import {
  validateSessionName,
  buildSafeEnv,
  SAFE_ENV_KEYS,
  splitDaemonArgs,
  shellQuote,
  composeSideBySideCaptureRows,
  parseAttachInput,
} from "../lib/pty-manager.mjs";

const DEFAULT_DAEMON = process.env.PTY_DAEMON || "default";

describe("validateSessionName", () => {
  it("accepts simple alphanumeric names", () => {
    expect(() => validateSessionName("agent1")).not.toThrow();
    expect(() => validateSessionName("mySession")).not.toThrow();
    expect(() => validateSessionName("Agent123")).not.toThrow();
    expect(() => validateSessionName("SESSION1")).not.toThrow();
  });

  it("accepts dots in names", () => {
    expect(() => validateSessionName("agent.v2")).not.toThrow();
    expect(() => validateSessionName("test.host.name")).not.toThrow();
    expect(() => validateSessionName("a.b.c")).not.toThrow();
  });

  it("accepts hyphens in names", () => {
    expect(() => validateSessionName("my-agent")).not.toThrow();
    expect(() => validateSessionName("test-123")).not.toThrow();
    expect(() => validateSessionName("a-b-c")).not.toThrow();
  });

  it("accepts underscores in names", () => {
    expect(() => validateSessionName("my_agent")).not.toThrow();
    expect(() => validateSessionName("test_123")).not.toThrow();
    expect(() => validateSessionName("a_b_c")).not.toThrow();
  });

  it("accepts mixed valid characters", () => {
    expect(() => validateSessionName("agent-1.test_v2")).not.toThrow();
    expect(() => validateSessionName("my_agent-1.v2")).not.toThrow();
    expect(() => validateSessionName("Agent_1.test-v2")).not.toThrow();
  });

  it("accepts single character names", () => {
    expect(() => validateSessionName("a")).not.toThrow();
    expect(() => validateSessionName("Z")).not.toThrow();
    expect(() => validateSessionName("5")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateSessionName("")).toThrow("session name is required");
  });

  it("rejects null", () => {
    expect(() => validateSessionName(null)).toThrow("session name is required");
  });

  it("rejects undefined", () => {
    expect(() => validateSessionName(undefined)).toThrow(
      "session name is required"
    );
  });

  it("rejects non-string types", () => {
    expect(() => validateSessionName(123)).toThrow("session name is required");
    expect(() => validateSessionName({})).toThrow("session name is required");
    expect(() => validateSessionName([])).toThrow("session name is required");
    expect(() => validateSessionName(true)).toThrow("session name is required");
  });

  it("rejects names starting with dash", () => {
    expect(() => validateSessionName("-agent")).toThrow(
      "invalid session name"
    );
    expect(() => validateSessionName("--agent")).toThrow(
      "invalid session name"
    );
  });

  it("rejects names starting with dot", () => {
    expect(() => validateSessionName(".agent")).toThrow(
      "invalid session name"
    );
    expect(() => validateSessionName("..agent")).toThrow(
      "invalid session name"
    );
  });

  it("rejects names starting with underscore", () => {
    expect(() => validateSessionName("_agent")).toThrow(
      "invalid session name"
    );
    expect(() => validateSessionName("__agent")).toThrow(
      "invalid session name"
    );
  });

  it("rejects names with slashes", () => {
    expect(() => validateSessionName("foo/bar")).toThrow(
      "invalid session name"
    );
    expect(() => validateSessionName("../etc/passwd")).toThrow(
      "invalid session name"
    );
    expect(() => validateSessionName("foo\\bar")).toThrow(
      "invalid session name"
    );
  });

  it("rejects names with spaces", () => {
    expect(() => validateSessionName("my agent")).toThrow(
      "invalid session name"
    );
    expect(() => validateSessionName(" agent")).toThrow(
      "invalid session name"
    );
    expect(() => validateSessionName("agent ")).toThrow(
      "invalid session name"
    );
  });

  it("rejects names with newlines", () => {
    expect(() => validateSessionName("my\nagent")).toThrow(
      "invalid session name"
    );
    expect(() => validateSessionName("my\ragent")).toThrow(
      "invalid session name"
    );
    expect(() => validateSessionName("my\ragent")).toThrow(
      "invalid session name"
    );
  });

  it("rejects names longer than 128 chars", () => {
    const tooLong = "a".repeat(129);
    expect(() => validateSessionName(tooLong)).toThrow("invalid session name");
  });

  it("accepts names exactly 128 chars", () => {
    const exactly128 = "a".repeat(128);
    expect(() => validateSessionName(exactly128)).not.toThrow();
  });

  it("rejects names with special characters", () => {
    expect(() => validateSessionName("agent@host")).toThrow(
      "invalid session name"
    );
    expect(() => validateSessionName("agent$")).toThrow("invalid session name");
    expect(() => validateSessionName("agent!")).toThrow("invalid session name");
    expect(() => validateSessionName("agent#")).toThrow("invalid session name");
    expect(() => validateSessionName("agent%")).toThrow("invalid session name");
    expect(() => validateSessionName("agent&")).toThrow("invalid session name");
    expect(() => validateSessionName("agent*")).toThrow("invalid session name");
    expect(() => validateSessionName("agent+")).toThrow("invalid session name");
    expect(() => validateSessionName("agent=")).toThrow("invalid session name");
    expect(() => validateSessionName("agent?")).toThrow("invalid session name");
  });
});

describe("buildSafeEnv", () => {

  it("includes whitelisted keys from process.env", () => {
    const result = buildSafeEnv();
    if (process.env.PATH) {
      expect(result.PATH).toBe(process.env.PATH);
    }
    if (process.env.HOME) {
      expect(result.HOME).toBe(process.env.HOME);
    }
  });

  it("allows extra arg to override process.env values", () => {
    const extra = { PATH: "/custom/path", TERM: "xterm-256color" };
    const result = buildSafeEnv(extra);
    expect(result.PATH).toBe("/custom/path");
    expect(result.TERM).toBe("xterm-256color");
  });

  it("ignores non-whitelisted keys from extra", () => {
    process.env.LD_PRELOAD = "evil.so";
    const result = buildSafeEnv({ LD_PRELOAD: "evil.so" });
    expect(result.LD_PRELOAD).toBeUndefined();
  });

  it("returns empty object when no matching keys", () => {
    const envWithoutSafe = {};
    for (const key of Object.keys(process.env)) {
      if (!SAFE_ENV_KEYS.includes(key)) {
        envWithoutSafe[key] = process.env[key];
      }
    }
    const result = buildSafeEnv();
    expect(Object.keys(result).length).toBeGreaterThan(0);
    expect(Object.keys(result).every((k) => SAFE_ENV_KEYS.includes(k))).toBe(
      true
    );
  });

  it("handles undefined extra gracefully", () => {
    expect(() => buildSafeEnv(undefined)).not.toThrow();
    const result = buildSafeEnv(undefined);
    expect(result).toBeInstanceOf(Object);
  });

  it("handles null extra gracefully", () => {
    expect(() => buildSafeEnv(null)).not.toThrow();
    const result = buildSafeEnv(null);
    expect(result).toBeInstanceOf(Object);
  });

  it("only includes keys in SAFE_ENV_KEYS", () => {
    const result = buildSafeEnv();
    for (const key of Object.keys(result)) {
      expect(SAFE_ENV_KEYS).toContain(key);
    }
  });
});

describe("splitDaemonArgs", () => {
  it("preserves a later @-token as data (the send-payload bug)", () => {
    const { daemon, args } = splitDaemonArgs(["send", "agent", "@everyone deploy now"]);
    expect(daemon).toBe(DEFAULT_DAEMON);
    expect(args).toEqual(["send", "agent", "@everyone deploy now"]);
  });

  it("preserves a bare @-token argument to a non-daemon command", () => {
    const { daemon, args } = splitDaemonArgs(["send", "agent", "@everyone"]);
    expect(daemon).toBe(DEFAULT_DAEMON);
    expect(args).toEqual(["send", "agent", "@everyone"]);
  });

  it("consumes a leading @name selector", () => {
    const { daemon, args } = splitDaemonArgs(["@proj", "spawn", "x"]);
    expect(daemon).toBe("proj");
    expect(args).toEqual(["spawn", "x"]);
  });

  it("consumes a leading --daemon <name> selector", () => {
    const { daemon, args } = splitDaemonArgs(["--daemon", "proj", "list"]);
    expect(daemon).toBe("proj");
    expect(args).toEqual(["list"]);
  });

  it("consumes @name trailing a leading 'daemon' command", () => {
    const { daemon, args } = splitDaemonArgs(["daemon", "@proj"]);
    expect(daemon).toBe("proj");
    expect(args).toEqual(["daemon"]);
  });

  it("consumes @name trailing the 'd' alias", () => {
    const { daemon, args } = splitDaemonArgs(["d", "@proj"]);
    expect(daemon).toBe("proj");
    expect(args).toEqual(["d"]);
  });

  it("consumes --daemon <name> trailing a leading 'daemon' command", () => {
    const { daemon, args } = splitDaemonArgs(["daemon", "--daemon", "proj"]);
    expect(daemon).toBe("proj");
    expect(args).toEqual(["daemon"]);
  });

  it("does NOT treat @name after a non-daemon command as a selector", () => {
    const { daemon, args } = splitDaemonArgs(["spawn", "@weird"]);
    expect(daemon).toBe(DEFAULT_DAEMON);
    expect(args).toEqual(["spawn", "@weird"]);
  });

  it("returns empty args for no tokens", () => {
    const { daemon, args } = splitDaemonArgs([]);
    expect(daemon).toBe(DEFAULT_DAEMON);
    expect(args).toEqual([]);
  });
});

describe("shellQuote", () => {
  it("wraps a plain token in single quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
  });

  it("quotes spaces", () => {
    expect(shellQuote("a b c")).toBe("'a b c'");
  });

  it("makes shell metacharacters literal", () => {
    expect(shellQuote("a;b")).toBe("'a;b'");
    expect(shellQuote("$(touch x)")).toBe("'$(touch x)'");
    expect(shellQuote("`id`")).toBe("'`id`'");
    expect(shellQuote("a|b&c")).toBe("'a|b&c'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("composeSideBySideCaptureRows", () => {
  it("renders two capture buffers with headers, clipping, divider, and padding", () => {
    const rows = composeSideBySideCaptureRows({
      leftName: "alpha",
      rightName: "beta",
      leftCapture: "short\nleft line is too long\n",
      rightCapture: "right side is also too long\nok",
      leftWidth: 8,
      rightWidth: 8,
      height: 4,
    });

    expect(rows).toEqual([
      "alpha   │beta    ",
      "short   │right si",
      "left lin│ok      ",
      "        │        ",
    ]);
  });
});

describe("SAFE_ENV_KEYS", () => {
  it("contains expected essential keys", () => {
    expect(SAFE_ENV_KEYS).toContain("PATH");
    expect(SAFE_ENV_KEYS).toContain("HOME");
    expect(SAFE_ENV_KEYS).toContain("USER");
    expect(SAFE_ENV_KEYS).toContain("TERM");
  });

  it("contains API keys for LLM providers", () => {
    expect(SAFE_ENV_KEYS).toContain("ANTHROPIC_API_KEY");
    expect(SAFE_ENV_KEYS).toContain("OPENAI_API_KEY");
  });

  it("contains agent chain related keys", () => {
    expect(SAFE_ENV_KEYS).toContain("NAMESPACE_ID");
    expect(SAFE_ENV_KEYS).toContain("AGENT_CHAIN_ROOT");
    expect(SAFE_ENV_KEYS).toContain("AGENT_CHAIN_CLI");
    expect(SAFE_ENV_KEYS).toContain("PTY_DAEMON");
  });

  it("is an array", () => {
    expect(Array.isArray(SAFE_ENV_KEYS)).toBe(true);
  });

  it("has more than 5 entries", () => {
    expect(SAFE_ENV_KEYS.length).toBeGreaterThan(5);
  });
});

describe("parseAttachInput", () => {
  const frame = (c, r) => `\x1b_ptymgr:resize:${c}:${r}\x1b\\`;

  it("forwards plain keystrokes untouched", () => {
    const { forward, resizes, rest } = parseAttachInput(Buffer.from("ls -la\r"));
    expect(forward.toString()).toBe("ls -la\r");
    expect(resizes).toEqual([]);
    expect(rest.length).toBe(0);
  });

  it("forwards a lone trailing ESC (the Escape key), not held", () => {
    const { forward, resizes, rest } = parseAttachInput(Buffer.from("\x1b"));
    expect(forward.toString()).toBe("\x1b");
    expect(resizes).toEqual([]);
    expect(rest.length).toBe(0);
  });

  it("forwards an arrow-key CSI sequence untouched", () => {
    const { forward, resizes } = parseAttachInput(Buffer.from("\x1b[A"));
    expect(forward.toString()).toBe("\x1b[A");
    expect(resizes).toEqual([]);
  });

  it("extracts a resize frame and forwards the surrounding input", () => {
    const { forward, resizes } = parseAttachInput(Buffer.from("a" + frame(80, 24) + "b"));
    expect(resizes).toEqual([{ cols: 80, rows: 24 }]);
    expect(forward.toString()).toBe("ab");
  });

  it("extracts multiple frames in one chunk", () => {
    const { resizes } = parseAttachInput(Buffer.from(frame(80, 24) + frame(100, 30)));
    expect(resizes).toEqual([{ cols: 80, rows: 24 }, { cols: 100, rows: 30 }]);
  });

  it("reassembles a frame split across two reads", () => {
    const whole = frame(120, 30);
    const first = parseAttachInput(Buffer.from("x" + whole.slice(0, 10)));
    expect(first.resizes).toEqual([]);
    expect(first.forward.toString()).toBe("x");
    const second = parseAttachInput(Buffer.concat([first.rest, Buffer.from(whole.slice(10) + "y")]));
    expect(second.resizes).toEqual([{ cols: 120, rows: 30 }]);
    expect(second.forward.toString()).toBe("y");
  });
});
