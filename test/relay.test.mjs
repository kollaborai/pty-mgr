// relay router: inbound enrollment gate + entity name stamping.
// Regression for the bug where start() passed raw config entities (no .name)
// into the pollers, so every addressed DM bounced with
// "@daemon is not enrolled to 'undefined'".
import { test, expect } from "bun:test";
import { RelayRouter, focusKey } from "../lib/msg-relay.mjs";

const CFG = {
  entities: {
    wbcv: { platform: "telegram", mode: "assistant", tokenEnv: "RELAY_TEST_UNSET_TOKEN", chatEnv: "RELAY_TEST_UNSET_CHAT" },
  },
  daemons: { wbcv: { entity: "wbcv" } },
  enrollments: {},
  supported: ["claude", "codex"],
};

test("start() stamps the entity name onto assistant pollers", async () => {
  const router = new RelayRouter(structuredClone(CFG));
  const polled = [];
  router.discover = async () => {};
  router.pollEntity = async (name, entity) => { polled.push({ name, entity }); };
  await router.start();
  router.stop();
  expect(polled.length).toBe(1);
  expect(polled[0].name).toBe("wbcv");
  expect(polled[0].entity.name).toBe("wbcv");
  expect(polled[0].entity.tokenEnv).toBe("RELAY_TEST_UNSET_TOKEN");
});

test("onInbound accepts a DM for a daemon enrolled to that entity", async () => {
  const router = new RelayRouter(structuredClone(CFG));
  // keep the unit off the machine's real daemon sockets: empty registry, no
  // rediscovery — delivery fails with "unknown target" AFTER the gate
  router.discover = async () => {};
  const replies = [];
  await router.onInbound(
    { name: "wbcv", ...CFG.entities.wbcv },
    "chat1",
    "@wbcv:mon hello",
    async (t) => replies.push(t),
  );
  expect(replies.join("\n")).not.toContain("not enrolled");
  expect(replies.join("\n")).toContain("couldn't reach @wbcv:mon");
});

test("onInbound rejects a DM for a daemon enrolled to another entity", async () => {
  const router = new RelayRouter(structuredClone(CFG));
  const replies = [];
  await router.onInbound(
    { name: "other-bot", ...CFG.entities.wbcv },
    "chat1",
    "@wbcv:mon hello",
    async (t) => replies.push(t),
  );
  expect(replies.join("\n")).toContain("not enrolled to 'other-bot'");
});

// ── short-form addressing ──────────────────────────────────────────────

const ENTITY = { name: "wbcv", ...CFG.entities.wbcv };

// router with a stubbed registry (one enrolled daemon) and captured deliveries
function fakeRouter(sessions, extraDaemons = {}) {
  const cfg = structuredClone(CFG);
  Object.assign(cfg.daemons, extraDaemons);
  const router = new RelayRouter(cfg);
  const put = (dname, names) => router.registry.set(dname, {
    sock: "/dev/null", entity: { name: "wbcv" },
    sessions: new Map(names.map((n) => [n, { cmd: "zsh", tier: 2, alive: true }])),
  });
  put("wbcv", sessions);
  for (const d of Object.keys(extraDaemons)) put(d, extraDaemons[d].__sessions || []);
  const delivered = [];
  router.deliver = async (target, body) => { delivered.push({ target, body }); return { ok: true, tier: 1 }; };
  return { router, delivered };
}

test("bare message routes to the entity's only live session", async () => {
  const { router, delivered } = fakeRouter(["mon"]);
  const replies = [];
  await router.onInbound(ENTITY, "chat1", "hello there", async (t) => replies.push(t));
  expect(replies).toEqual([]);
  expect(delivered).toEqual([{ target: { daemon: "wbcv", session: "mon" }, body: "hello there" }]);
});

test("bare message with several live sessions asks for an address, listing them", async () => {
  const { router, delivered } = fakeRouter(["mon", "dev"]);
  const replies = [];
  await router.onInbound(ENTITY, "chat1", "hello", async (t) => replies.push(t));
  expect(delivered).toEqual([]);
  expect(replies.join("\n")).toContain("@wbcv:mon");
  expect(replies.join("\n")).toContain("@wbcv:dev");
});

test("@daemon routes when the daemon has exactly one live session", async () => {
  const { router, delivered } = fakeRouter(["mon"]);
  await router.onInbound(ENTITY, "chat1", "@wbcv hi", async () => {});
  expect(delivered).toEqual([{ target: { daemon: "wbcv", session: "mon" }, body: "hi" }]);
});

test("@daemon with several sessions asks which one", async () => {
  const { router, delivered } = fakeRouter(["mon", "dev"]);
  const replies = [];
  await router.onInbound(ENTITY, "chat1", "@wbcv hi", async (t) => replies.push(t));
  expect(delivered).toEqual([]);
  expect(replies.join("\n")).toContain("which session?");
});

test("@session routes when the name is unique across enrolled daemons", async () => {
  const { router, delivered } = fakeRouter(["mon"]);
  await router.onInbound(ENTITY, "chat1", "@mon what are the dirty files", async () => {});
  expect(delivered).toEqual([{ target: { daemon: "wbcv", session: "mon" }, body: "what are the dirty files" }]);
});

test("unresolvable @word with a focused target is treated as message content", async () => {
  const { router, delivered } = fakeRouter(["mon"]);
  router.lastTarget.set(focusKey("wbcv", "chat1"), { daemon: "wbcv", session: "mon" });
  await router.onInbound(ENTITY, "chat1", "@here check this", async () => {});
  expect(delivered).toEqual([{ target: { daemon: "wbcv", session: "mon" }, body: "@here check this" }]);
});

// ── cold daemons boot from short/bare forms ────────────────────────────

const BOOTABLE = { wbcv: { entity: "wbcv", workspace: { dir: "~/dev/webceive-services" } } };

test("@daemon with nothing running resolves to session 'main' for cold start", async () => {
  const { router, delivered } = fakeRouter([], BOOTABLE);
  await router.onInbound(ENTITY, "chat1", "@wbcv wake up", async () => {});
  expect(delivered).toEqual([{ target: { daemon: "wbcv", session: "main" }, body: "wake up" }]);
});

test("bare message with nothing running boots the only bootable daemon", async () => {
  const { router, delivered } = fakeRouter([], BOOTABLE);
  const replies = [];
  await router.onInbound(ENTITY, "chat1", "hi", async (t) => replies.push(t));
  expect(replies).toEqual([]);
  expect(delivered).toEqual([{ target: { daemon: "wbcv", session: "main" }, body: "hi" }]);
});

test("bare message with nothing running and nothing bootable still asks for an address", async () => {
  const { router, delivered } = fakeRouter([]); // CFG's wbcv has no workspace/agent
  const replies = [];
  await router.onInbound(ENTITY, "chat1", "hi", async (t) => replies.push(t));
  expect(delivered).toEqual([]);
  expect(replies.join("\n")).toContain("address an agent first");
});

// ── replies chase the last speaker ─────────────────────────────────────

test("an agent's DM turn moves bare-reply focus to it", async () => {
  const { router, delivered } = fakeRouter(["mon", "dev"]);
  process.env.RELAY_TEST_UNSET_TOKEN = "tok";
  process.env.RELAY_TEST_UNSET_CHAT = "42";
  try {
    router.sendDM = async () => {};
    await router.relayTurn("wbcv", "dev", "build finished");
    expect(router.lastTarget.get(focusKey("wbcv", "42"))).toEqual({ daemon: "wbcv", session: "dev" });
    // two live sessions would normally bounce a bare message — focus from
    // the speaker's turn routes it instead
    await router.onInbound(ENTITY, "42", "nice, ship it", async () => {});
    expect(delivered).toEqual([{ target: { daemon: "wbcv", session: "dev" }, body: "nice, ship it" }]);
  } finally {
    delete process.env.RELAY_TEST_UNSET_TOKEN;
    delete process.env.RELAY_TEST_UNSET_CHAT;
  }
});

test("a failed DM send does not steal focus", async () => {
  const { router } = fakeRouter(["mon"]);
  process.env.RELAY_TEST_UNSET_TOKEN = "tok";
  process.env.RELAY_TEST_UNSET_CHAT = "42";
  try {
    router.sendDM = async () => { throw new Error("telegram down"); };
    await router.relayTurn("wbcv", "mon", "hello?").catch(() => {});
    expect(router.lastTarget.get(focusKey("wbcv", "42"))).toBeUndefined();
  } finally {
    delete process.env.RELAY_TEST_UNSET_TOKEN;
    delete process.env.RELAY_TEST_UNSET_CHAT;
  }
});

// ── focus is scoped per entity, not just per chat id ───────────────────
// Telegram's private-chat id IS the human's own user id, so it's identical
// across every bot they run. Two entities sharing a physical chat id must
// not steal each other's focus.

test("addressing one entity's daemon doesn't steal a bare reply meant for another entity", async () => {
  const cfg = {
    entities: {
      work: { platform: "telegram", mode: "assistant", tokenEnv: "RELAY_TEST_UNSET_TOKEN", chatEnv: "RELAY_TEST_UNSET_CHAT" },
      personal: { platform: "telegram", mode: "assistant", tokenEnv: "RELAY_TEST_UNSET_TOKEN2", chatEnv: "RELAY_TEST_UNSET_CHAT2" },
    },
    daemons: { workd: { entity: "work" }, persd: { entity: "personal" } },
    enrollments: {},
    supported: ["claude", "codex"],
  };
  const router = new RelayRouter(cfg);
  router.discover = async () => {};
  router.registry.set("workd", {
    sock: "/dev/null", entity: { name: "work" },
    sessions: new Map([["main", { cmd: "zsh", tier: 2, alive: true }]]),
  });
  router.registry.set("persd", {
    sock: "/dev/null", entity: { name: "personal" },
    sessions: new Map([["main", { cmd: "zsh", tier: 2, alive: true }]]),
  });
  const delivered = [];
  router.deliver = async (target, body) => { delivered.push({ target, body }); return { ok: true, tier: 1 }; };

  const WORK = { name: "work", ...cfg.entities.work };
  const PERSONAL = { name: "personal", ...cfg.entities.personal };
  const CHAT_ID = "555555"; // same physical Telegram user, both bots

  await router.onInbound(WORK, CHAT_ID, "@workd hi", async () => {});
  expect(delivered).toEqual([{ target: { daemon: "workd", session: "main" }, body: "hi" }]);

  const replies = [];
  await router.onInbound(PERSONAL, CHAT_ID, "hey, what's up", async (t) => replies.push(t));
  expect(replies.join("\n")).not.toContain("not enrolled");
  expect(delivered).toEqual([
    { target: { daemon: "workd", session: "main" }, body: "hi" },
    { target: { daemon: "persd", session: "main" }, body: "hey, what's up" },
  ]);
});

// ── hook-capable echo suppression ──────────────────────────────────────

test("a hook turn permanently suppresses the tier-2 screen echo", async () => {
  const router = new RelayRouter(structuredClone(CFG));
  await router.relayTurn("wbcv", "mon", "turn-final text"); // creds unset: drops, but marks
  const replies = [];
  await router.settleEcho({ daemon: "wbcv", session: "mon" }, async (t) => replies.push(t));
  expect(replies).toEqual([]);
  expect(router.hookCapable.has("@wbcv:mon")).toBe(true);
});
