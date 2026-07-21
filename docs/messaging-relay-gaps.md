---
eyebrow: Mentiko · pty-mgr · gap review
title: Agent Messaging Relay — Gap Analysis
dek: Adversarial review of messaging-relay.md by four parallel agents plus live code, npm, and vendor-doc verification. The foundation checks out real; the ship-blockers are concentrated in the parts no framework gives you — failover, injection safety, authorization, and the "agent never knows the relay exists" mechanism.
meta: Reviews=messaging-relay.md, Target=lib/pty-manager.mjs @ v1.5.0, Verdict=*not buildable as written*, Status=review
footer: pty-mgr — messaging relay gap analysis
---
# agent messaging relay — gap analysis

Review of [`messaging-relay.md`](./messaging-relay.md). Method: four parallel
adversarial agents (dependency reality-check, distributed-systems, routing+security,
vision+ops), each grounded against the **actual v1.5.0 code** in `lib/pty-manager.mjs`
(not the spec's stale v1.4.3 line refs), the live npm registry, and current vendor
docs. Load-bearing code claims were re-verified by hand this session.

Evidence tags: **[code]** = read the exact lines this session · **[npm]** = primary-source
registry/tarball · **[docs]** = current vendor doc fetched live · **[design]** = reasoned
failure mode, not runtime-proven (no relay code exists yet, so nothing here is runtime-verified).

## verdict

The foundation is sound and the spec is honest about the parts it verified. The Chat SDK
is **real**, its API matches the spec **to the method signature**, and the bundle numbers
**reproduce to the decimal**. But the spec is **not buildable as written**: ~12 blockers,
almost all in the layer the framework does *not* cover — hub failover, PTY-injection safety,
authorization, and the stop-hook mechanism that makes "the agent never knows" true. None are
fatal to the design; all are cheap to fix now because zero relay code exists yet. The single
highest-leverage change is **resequencing** (phase 0 below), not any one fix.

## keystone: the SDK is real (this was the biggest risk, and it clears)

Verified via raw `registry.npmjs.org` JSON, GitHub API, and downloaded+extracted tarballs —
not doc summaries:

- `chat`, `@chat-adapter/telegram`, `@chat-adapter/slack` are **real, Vercel-maintained**
  (`github.com/vercel/chat`, MIT, 2210★, `chat` 1.67M weekly downloads). **[npm]**
- **All 18 `StateAdapter` methods** match §3.6 exactly (read from `chat@4.34.0`'s shipped
  `.d.ts`). **[npm]**
- §2's engagement mapping is **verbatim from the shipped types** — "ONLY called for mentions
  in unsubscribed threads," `subscribe()` "(persists across restarts)," and the exact
  "subscribe when it's a 1:1 conversation…" quote. The spine holds. **[npm]**
- Bundle claim **independently reproduced**: 333 modules, 58.39 MB binary, +1.28 MB delta —
  every masthead number matches to the rounded decimal. **[npm]**

Two corrections that follow from this:

- **§9 "adapters are beta" is FALSE.** No `beta` dist-tag exists; downloads are mature-tier.
  The real risk is **churn, not beta**: `@chat-adapter/slack` has 49 published versions in
  ~6.5 months, `telegram` 23 in ~5 months (~1–2 releases/week), and `chat` pulls a
  beta-tagged transitive `@workflow/serde`. "Pin exact versions + smoke test" is right; the
  *stated reason* is wrong. **[npm]**
- **"+1.3 MB verified" leaves no receipt.** `package.json`/`bun.lock`/`node_modules` in the
  working tree have **zero** trace of these deps — the compile was a throwaway probe. True as
  "was run," misleading as "reproducible from repo state." Commit a pinned smoke-build script
  so "verified" has a receipt. **[code]**

---

## BLOCKERS (ranked)

### failover & concurrency — the hub is a single point of failure with no safety net

**1. Correlator loses every in-flight `p ask` on *any* hub restart, and the late reply is typed raw into a live PTY. [design]**
`pendingAsks` is an in-memory `Map` (§3.5), zero persistence; §6 cleanup tears down the bot
without draining it. A routine upgrade restart — not just a crash — wipes every open ask. The
dangerous half: if the human's "yes" lands after the old hub dies, it reaches a new hub with an
empty Correlator, `correlator.take()` misses, and it **free-falls to `deliver()` → `sendKeys(session,"yes\r")`** —
typed as literal input into whatever's on screen. (`yes` is also a real Unix binary → infinite
loop at a shell prompt.)
*Fix:* persist asks in a sqlite `pending_asks` table; on graceful teardown, reject/notify every
open ask in-thread before killing the bot; on boot, sweep orphans so a stray late reply resolves
against a durable "is this thread mid-ask" check instead of PTY free-fall. Add a distinct error
code for "registered-then-lost" vs "never-reached-hub" so retries don't double-post.

**2. Hub lease has no fencing token and no "I lost it → stop polling" kill switch → split-brain double-poll. [design]**
§3.8's winner "refreshes the ttl on a timer" with no compare-and-swap. `bot.initialize()` (§4) is
a **one-shot boot call** — it never re-checks ownership. So an event-loop stall (big xterm render,
registry `JSON.stringify`, sqlite write under contention — all plausible on this single-threaded
runtime) can let the TTL lapse, a successor claims and starts polling, the stall ends, and the old
hub's heartbeat blindly overwrites the row back — **two pollers on one bot token → Telegram 409 on
every cycle**, potentially flapping forever. No clock skew needed; single machine.
*Fix:* fencing token + CAS on every refresh (`UPDATE … WHERE pid=? AND acquiredAt=?`; 0 rows = lease
lost → synchronously tear down `bot`). State actual TTL and refresh-interval numbers. Specify the
non-hub claim-retry loop/cadence (implied in §6, never shown). Use the stored `pid` for a free
`kill -0` liveness check.

**3. `getUpdates` offset ownership is undesigned → duplicate or lost inbound on every failover. [design]**
Today `tgState.lastUpdateId` is in-process only **[code, :928]**. The new `StateAdapter` (§3.6) has
**no offset-shaped method** — the offset lives inside `@chat-adapter/telegram`'s black box. A failover
constructs a fresh adapter with no carried offset: depending on the old adapter's ack timing, the new
hub either **re-injects already-delivered messages** (double PTY injection) or **permanently loses**
messages the old hub acked-but-didn't-process (Telegram never redelivers past an acked offset).
Compounds with #2 during any split-brain window.
*Fix:* persist the offset in `kv["relay:offset:telegram"]`, written by RelayCore **only after** a
message is fully processed — plus dedup by `update_id` in a small sqlite "seen" set. If the adapter
exposes no raw-update/manual-ack hook, that's a **dependency blocker**, not a tweak — verify before
phase 2.

**4. The hub lease is built on the weaker of the two primitives the spec itself defines; sqlite contention is unhandled. [design]**
§3.6's `locks` table has a `token` column for fenced extend/release — but §3.8's lease uses plain `kv`
(no token). The most safety-critical mutex in the system uses the weaker primitive. No `PRAGMA busy_timeout`
anywhere (first `bun:sqlite` use in this codebase) → `SQLITE_BUSY` throws instead of queuing; if a broad
`catch` in `claimHub()` can't tell `SQLITE_BUSY` from "key exists," every racing daemon at boot concludes
"someone else won" → **permanent no-hub livelock**. `forceReleaseLock` can also steal a lease from a
live-but-stalled hub.
*Fix:* build the lease on the token-bearing `locks` table; set `busy_timeout`; retry with jitter; handle
`SQLITE_BUSY` distinctly; gate `forceReleaseLock` behind a `kill -0` pid check or a grace period >> TTL.

**5. Zero delivery acknowledgement in either direction — messages silently vanish. [code+design]**
`deliver()` (§4) is fire-and-forget: the proxy branch isn't awaited, has no try/catch, and
`touchLastTarget` runs **regardless of success**. Sibling daemon down/restarting → the human's reply
(maybe a "yes") disappears with **no error posted back** — which directly guts the pitch of "reply like
you'd message a teammate." Outbound is equally unguarded: a `p hook stop` notify that fails to reach the
hub can fail **silently**, so the one signal meant to say "the agent needs you" just doesn't fire.
*Fix:* await + catch in `deliver()`; on failure post a visible error into the thread; gate
`touchLastTarget` on success; make `p notify`/`p ask`/`p hook stop` check `ok` and exit non-zero loudly;
reuse the existing `queue` table for a short retry/dead-letter window on cross-daemon sends.

**6. No per-thread ordering, despite the lock primitive existing for it. [design]**
§4's RelayCore sketch never calls `acquireLock`. Two rapid replies in one thread ("y" then "actually no"
answering a pending ask) can reach `correlator.take()` out of order — the wrong answer resolves the ask and
**the loser falls through to raw PTY injection**. Same class as the timeout-vs-late-reply race (#minor) and
the unreviewed `onAction` button path.
*Fix:* serialize per-thread — wrap the whole inbound handler in the per-thread lock, or keep an in-memory
per-thread promise chain. Never let a correlator-miss silently become a generic `deliver()`.

### injection safety & authorization — a phone-to-shell bridge with the guards missing

**7. Channel-mode "authorization" is agent-name lookup, not a human allowlist. [code+design]**
§2's routing graph gates only on "does this agent name exist" (`KN{known agent?}`). §3.1 config has **no
per-user allowlist**. In a Slack channel, **anyone who can `@mention` the bot can drive a terminal**
("@build-worker rm the deploy lock"). Today's code at least pins one identity (`chatId === knownId ||
userId === knownId`, **:1062-1064**); the redesign trades that for "whoever's in the channel" with nothing
filling the gap — and §9 doesn't even list it as open.
*Fix:* per-agent authorized-user allowlist in `pty-mgr.config.json`, checked in `onMention`/`onSubscribed`
before `deliver()`, independent of channel membership.

**8. Zero sanitization/confirmation on the default delivery path — this is the real blast radius. [code]**
`onSubscribed` with no pending ask sends text **straight** to `deliver()` → `sendKeys` →
`write()` **(:296-307)**, a raw PTY write. §3.1's own example spawns a bare `zsh`. A reply of `rm -rf ~`
executes verbatim with the daemon's permissions; against a tool-enabled coding agent, any prompt-injection
payload becomes its next literal instruction. The `p ask` y/n gate only covers asks the agent *chooses* to
make — nothing guards unsolicited inbound, which is the common case.
*Fix:* state a policy, don't hope. Minimum: per-session risk tiers (`relay.confirm: destructive-only|all|off`)
with a preview/confirm step for anything routed at a shell session, before this faces a phone.

**9. Relay credentials leak into every bridged session → bot-token exfil. [code, :51-54]**
`SAFE_ENV_KEYS` already carries `TELEGRAM_BOT_TOKEN` **and** `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` into every
spawned session; `wrap` gets the full unfiltered daemon env. A human reachable through the relay can ask the
bridged agent to `echo $TELEGRAM_BOT_TOKEN` and **exfiltrate the bot's own credential back out the same
channel** — full bot takeover, plus every other inherited secret. §3.1 proposes adding the Slack tokens to
this same pattern.
*Fix:* exclude relay creds (and ideally the API keys) from `SAFE_ENV_KEYS` and from `wrap`'s base env —
denylist subtraction on `...process.env`, not just an allowlist overlay.

**10. No origin authentication on the socket protocol → identity spoofing / approval phishing. [code]**
`tg-send`/`tg-wait` already accept a caller-supplied `session` with no verification (**:1400, :1420-1423**).
§7's new `origin:{daemon,session,agent,cwd}` is described the same way — self-asserted, no signing. The relay
raises the stakes: a human is meant to trust `[agent]`-prefixed messages when approving a `p ask`, so any local
process in **any** session can forge `origin.agent` to phish an approval for a destructive action under a
trusted name.
*Fix:* the daemon (not the caller) stamps identity-bearing `origin` fields from the actual connection context;
never trust client-supplied values for anything shown to a human as identity.

### routing correctness — the "reply becomes the next turn" magic has holes

**11. Cross-daemon reply never presses Enter — Flow D is dead on arrival. [code, :1287-1299]**
`deliver()`'s remote branch and §3.9 proxy `{cmd:"send", args:{text}}`. The real `send` handler defaults
`enter=false` → takes the `sendKeys(name, text)`-only branch, **no `\r` ever sent**. Every *other* caller in
the codebase passes `enter:true` (flow `:2537`, CLI `:3238`) — the spec's "reuse" is the lone caller that omits
it. 100% reproducible; every cross-daemon reply sits as unsubmitted text.
*Fix:* `args:{ text, enter:true }` in both the sketch and §3.9.

**12. No idle-gate before injection, and multi-line replies never submit. [code, :296-307, :508]**
`sendKeys` → `write()` is a raw PTY write with **no** notion of "is the target at a prompt." Landing text
mid-turn, in a pager, in `vim`, or at a `sudo` prompt does whatever those bytes do there. Worse: `write()`
wraps any text containing `\n` as bracketed paste (`\x1b[200~…\x1b[201~`), so `deliver()`'s local
`sendKeys(session, text + "\r")` on a multi-line reply puts the **`\r` inside the paste bracket** → readline
buffers it, never submits. Multi-line phone replies silently don't land, for a second independent reason from
#11. The flow engine already solved this exact problem with `sendFlowMessageConfirmed`/`waitForFlowSessionReady`
(**:2542, :2561** — send, poll the transcript for acceptance, nudge with a bare Enter) and the relay reuses
**none** of it.
*Fix:* two writes (text, delay, separate `\r`), and a best-effort acceptance check before declaring "delivered" —
adapt `sendFlowMessageConfirmed` rather than fire-and-forget.

**13. The flagship channel example may never fire the mechanism it depends on. [npm+design]**
§2 ties mention-detection to `RELAY_BOT_USERNAME`/`message.isMention` — i.e. mentions of the **bot's own handle**.
But Flow C's example is `@build-worker restart the api` — the **agent name**, not the bot. Unless `build-worker`
is itself a mentionable Slack identity (contradicts the single-bot-identity model), Slack emits no mention event,
`onNewMention` never fires, and per §2's own contract the message is **invisible to RelayCore** — dropped with no
feedback.
*Fix:* resolve the addressing grammar before build — either `@ptybot @build-worker …` (contradicts every example)
or run `parseAddress` on all channel messages, which means it can't use `onNewMention` as the gate. Verify against
the SDK's real mention semantics first.

### the "agent never knows" mechanism — undesigned where it counts

**14. Cursor's stop-hook is confirmed broken; "any agent" is false today. [docs]**
§7 treats the three CLIs as symmetric. They aren't: Claude Code and Codex both ship `last_assistant_message`
inline in the Stop hook (works). **Cursor's `afterAgentResponse` does NOT fire in headless CLI mode** —
acknowledged by Cursor's team as a known gap, still open (forum, 2026-03-30). It needs a different path
(`--output-format stream-json` + the generic `stop` hook).
*Fix:* stop writing "one small adapter per CLI" as three equal afternoons. Descope Cursor from v1 explicitly, or
design its stream-json path separately. The vision says "any agent" — it isn't, yet.

**15. The `onQuestion` trigger is undesigned and the spec contradicts itself on it. [docs+design]**
§7 makes `onQuestion` the **default** trigger (it gates every assistant-mode message); §9 simultaneously lists the
trigger default as **still open**. And nothing defines *how* a question is detected — regex on "?"? an LLM classifier
(cost, latency, another failure mode)? Turn-final coding-agent text is full of rhetorical and real questions;
false positives spam you (breaks "no babysitting"), false negatives leave a real blocking question silent and the
agent stalled — **the exact failure the vision exists to kill.**
*Fix:* name the detection mechanism, test it against a corpus of real Claude Code/Codex turn-final messages, and get
an actual sign-off on the default. It's an unmade decision wearing a decided hat.

**16. One-shot `--print` agents are likely the *majority* case, left as a shrug. [design]**
§9 lists this as open with no lean. It isn't niche: pty-mgr's own flow engine spawns `codex --yolo` and non-interactive
`claude` turns; chain-execution is the stated product mission. For a one-shot agent there is **no process left to inject
into** — "your reply arrives as its next input" is categorically false for what may be most usage.
*Fix:* pick respawn/resume — on reply, spawn a fresh `--continue`/`--resume` invocation seeded with the reply (both
Claude Code and Codex support session resume), not `sendKeys` into a dead PTY. Make it a real design.

---

## SERIOUS

- **17. `lastTarget` is `tgState.lastSession` renamed, not fixed. [code+design]** `touchLastTarget` overwrites on
  every deliver (§4) — same last-write-wins shape as today's bug (**:1400, :1077-1081**). And Telegram 1:1 DMs have
  no `message_thread_id`, so §3.2's thread id collapses to one id per human — `Directory.forThread` can't disambiguate
  multiple agents either. The *primary shipped scenario* (phase 2, Telegram assistant mode) has no better answer than
  today's misroute. *Fix:* route to whichever agent is actually **awaiting a reply**, or require re-addressing when >1
  agent is active in a DM; don't ship ">1 agent per flat DM" as solved.
- **18. Dead/killed session + stale bind → uncaught throw in the shared hub. [code]** `kill` doesn't clear
  `bind:`/`thread4session`/`lastTarget`; `write()` throws on an exited session (**:297-299**). A reply in a killed
  session's still-subscribed thread → `deliver()`'s local branch throws synchronously — and because **one hub serves
  every daemon**, one stale reply can take down routing for everyone. *Fix:* try/catch `deliver()`, clear the bind on
  failure and notify the thread; hook session removal to evict binds.
- **19. `@agent` collides across daemons → silent misroute. [design]** `agent:<name>` (§3.4) has no daemon qualifier;
  two daemons with a "build" agent → last registration wins, no error. §9 lists it open but §10 ships `@agent`
  addressing without gating on it. *Fix:* namespace the key `agent:<daemon>/<name>`; return "ambiguous" on collision.
- **20. Registry publication defeats daemon isolation for daemons that never opted in. [code+design]** §3.7 writes the
  registry file **unconditionally** on boot; CLAUDE.md sells `p daemon @proj` as *isolated*. Post-relay, every daemon
  publishes an enumerable session/cwd list and becomes proxy-`send`-targetable by the hub. Also a regression from a
  proven pattern: `p daemons`/`listDaemonSockets()` (**:1486-1506, :3118-3145**) already do **live socket probes**
  instead of trusting a passive mtime heartbeat — §3.7 reinvents it weaker, and §3.7-vs-§6 disagree on write cadence
  with no staleness threshold and no reaper for unclean deaths. *Fix:* opt-in registry publication; reuse
  `listDaemonSockets()` + `status` probe for liveness instead of mtime.
- **21. No observability surface. [design]** No `p relay status`/`threads`/`inspect`. To debug a misroute you read daemon
  stderr — which *is* babysitting a terminal, the thing being eliminated. *Fix:* `p relay status` (hub identity, provider
  connectivity, session count) and `p relay threads` (bind/lastTarget dump), phase 3.
- **22. Migration is all-or-nothing; `NO_HUB` behavior is undefined. [code+design]** Today's `p tg` is synchronous and
  self-contained (set two env vars, done). §8 makes `tg-send`/`tg-wait` **aliases of hub-dependent** `relay-*`, inserting
  a new `NO_HUB` failure into a path that was simple — a straight regression for the single-user who never set up a hub.
  The spec defines the code but never says what the CLI *does* with it. *Fix:* define `NO_HUB` CLI behavior; keep the
  direct-poll path as the zero-hub fallback rather than deleting it, at least until hub election has runway.
- **23. Rate limits + markdown-dialect translation unspecified. [docs+design]** One bot relaying many concurrent chain
  agents will hit Telegram/Slack per-bot/per-chat throttles — no queue/coalesce/backoff mentioned → 429s under fan-out.
  And turn-final text is full of code fences/bold; Telegram needs `parse_mode` with strict escaping (a `parse_mode` set
  without correct escaping is a 400 — the single most common Telegram-bot bug); Slack `mrkdwn` is a third dialect. (Raw
  ANSI is *not* a problem — `capture()` renders through `@xterm/headless` first.) *Fix:* a backpressure policy and a
  per-platform formatting/escaping policy; add both to §9.

## MINOR

- **24. Timeout-vs-late-reply race [design]:** even on a healthy hub, the Correlator timer firing as a genuine late reply
  arrives is a coin flip; the loser falls through to raw PTY injection. Prefer the resolve within a small grace window.
- **25. `onAction` (button y/n) unreviewed [design]:** wired in §4 boot but no RelayCore method sketched; unverified it
  routes through the same `take()` gate as a typed reply — if a human can both click and type, same double-resolve risk
  as #6.
- **26. `parseAddress` has no defined grammar [design]:** robustness against text that merely contains `@` (emails,
  `user@host`, handles) is unspecified; overlaps with #19/#13.
- **27. Graceful hub handoff vs. Telegram long-poll [design]:** teardown can't abort an in-flight ~50s long-poll; a
  successor claiming immediately may 409 against the outgoing hub. Cosmetic, but can delay the successor's first poll.
- **28. Line refs are stale:** spec pinned "@ v1.4.3"; code is v1.5.0 / 3400 lines. Anchors are close but drifting;
  re-pin before build.

---

## missing from §9's open-decisions list (it lists knobs, not the make-or-break forks)

§9's six forks (trigger default, addressing grammar, hub scope, telegram mode…) are real but mostly *tuning*. The
decisions that determine whether it works **at all** are absent:

1. **`NO_HUB` CLI behavior** (#22) — retry / fail-fast / no-op?
2. **`onQuestion` detection** — heuristic vs model call, and its false-pos/neg tolerance (#15).
3. **One-shot `--print` agents** — respawn/resume vs interactive-only (#16).
4. **Per-platform `parse_mode`/escaping policy** (#23).
5. **Rate-limit / backpressure policy** (#23).
6. **Reuse the existing flow-engine adapter parser** for stop-hook vs a second turn-final-text extractor (see phase 0).
7. **Authorization model** — per-user allowlist, or channel-membership = terminal access (#7).

## recommended resequencing — do this before phase 1

§10 builds PtyState (phase 1) then RelayCore+Telegram (phase 2) **before** the beta-adapter smoke test even runs. The
riskiest unknowns should gate the bet, not ride along as a footnote. Insert:

**Phase 0 (prove the bet):**
- Pin exact adapter versions and **commit** a smoke-build script (gives "+1.3 MB verified" a receipt).
- **Kill-the-hub-mid-poll** test against a real throwaway bot over hours — verify offset ack/failover behavior (#3) and
  whether the adapter exposes a manual-ack/raw-update hook. If it doesn't, that's a go/no-go on the dependency.
- Decide **one-shot handling** (#16), the **`onQuestion` detector** (#15), and the **authorization model** (#7) — these
  are design, not code, and they change everything downstream.
- Decide whether stop-hook **reuses `pty-mgr.config.json`'s `adapters.assistant` parser** (already extracts turn-final
  text well enough to drive `p flow run` today) instead of inventing a second extractor. Building two "parse Claude Code's
  final message" implementations is exactly the duplication the steering docs warn against.

Then phase 1 onward as written, with the failover/injection/auth fixes folded into the relevant phase.

## what's solid (steelman — this isn't one-sided)

- The Chat SDK subscribe/unsubscribe ↔ assistant/channel mapping (§2) is **real and correctly sourced**, not invented.
- Claude Code and Codex genuinely hand back turn-final text inline now — the core "agent never knows" trick is **less
  hand-wavy than it looks for 2 of 3 CLIs**.
- All four named platforms (Telegram/Slack/Teams/WhatsApp) have real Chat SDK adapters today, so the roadmap is
  **deliverable** — *if* you accept the framework lock-in.
- `requestSocket` already **rejects cleanly** on a dead hub (**:1441-1472**), so blocked `p ask` callers get a fast error,
  not a hang — a good primitive the design reuses correctly.
- **Zero relay code exists yet** — every fix above is still cheap.

## one honest tension to name in the doc

Adopting Chat SDK trades "no platform lock-in" for a **new** lock-in: a single-vendor, <7-month-old framework with
weekly churn, vs. the old design's direct calls to Telegram's years-stable Bot API. That may well be the right trade —
the SDK genuinely gives you Slack/Teams/WhatsApp for near-free — but it **contradicts CLAUDE.md's stated ethos**
("single-file, no dependencies beyond `@xterm/headless`, no build step") and the doc never names it. Make it a *made*
decision, not a buried one.
