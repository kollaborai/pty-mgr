# spec: telegram human-in-the-loop messaging

## what this is

a `p tg` command that lets agents running in pty sessions send messages
to marco via telegram and optionally block waiting for a reply.

designed for agent chains where the final "communication agent" step
needs to notify or ask the human without breaking the chain.

---

## user experience

### setup (one-time)

create a bot via @BotFather, get token. get your chat_id by messaging
the bot once and hitting getUpdates. then:

    export TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
    export TELEGRAM_CHAT_ID=987654321

add both to ~/.zshrc (or wherever). daemon picks them up on start.
no `p config` needed. same pattern as ANTHROPIC_API_KEY.

### agent chain usage

the communication agent's system prompt includes exactly this:

    to notify marco:          p tg "message"
    to ask marco something:   p tg "question" --reply
    to ask with timeout:      p tg "question" --reply --timeout 120

fire-and-forget:

    p tg "email summary: 3 new tasks created in linear"
    # sends message, exits 0 immediately. chain continues.

blocking reply:

    p tg "found 5 emails with action items. create linear tasks? (yes/no)" --reply
    # sends message
    # BLOCKS waiting for marco to reply on telegram
    # prints marco's reply to stdout
    # agent reads stdout and decides what to do

agent code pattern (pseudocode):

    reply=$(p tg "found anomaly in prod metrics. investigate now? (yes/no)" --reply --timeout 300)
    if [ "$reply" = "yes" ]; then
      p spawn investigation claude --print ...
    fi

### marco's experience on telegram

marco sees a message from the bot. replies normally. that's it.
no special commands, no formatting required. just reply and the
waiting agent gets unblocked.

---

## architecture

### env vars (add to SAFE_ENV_KEYS)

    TELEGRAM_BOT_TOKEN    required. bot token from @BotFather.
    TELEGRAM_CHAT_ID      required. marco's chat id (numeric string).

### daemon changes

on startup: if TELEGRAM_BOT_TOKEN is set, start a background poller.
the poller long-polls telegram's getUpdates API (timeout=25s).
tracks last `update_id` to avoid reprocessing on reconnect.

poller runs only in the daemon that has the env var. if you run
multiple named daemons (@proj1, @proj2), only the one started with
the token set will poll. this is the right behavior - one poller,
not N.

### socket protocol additions

two new commands added to handleCommand():

    { cmd: "tg-send", args: { message: "string" } }
    -> { ok: true }  or  { ok: false, error: "..." }

    { cmd: "tg-wait", args: { message: "string", timeout: 60000 } }
    -> holds socket open until reply arrives
    -> { ok: true, reply: "yes" }
    -> { ok: false, error: "TIMEOUT" }   if timeout expires
    -> { ok: false, error: "NO_TOKEN" }  if not configured

### reply queue

simple FIFO. one pending waiter at a time (marco is the only user).
when a telegram update arrives:
  - if queue has a waiter: dequeue, respond with reply text, close socket
  - if no waiter: drop the message (or log it to daemon stderr)

if a second tg-wait comes in while one is already waiting:
  - second caller gets { ok: false, error: "ALREADY_WAITING" } immediately
  - first waiter is unaffected

### CLI command

    p tg <message> [--reply] [--timeout <seconds>]

aliases: none needed. `tg` is clear.

implementation:
- parses --reply flag, --timeout value (default: 60s)
- if --reply: sends tg-wait command, blocks on socket, prints reply to stdout
- if not --reply: sends tg-send command, exits

exit codes:
  0  = sent (fire-and-forget) or reply received
  1  = error (no token, daemon not running, etc)
  2  = timeout (--reply, no response within timeout)

---

## implementation plan

### phase 1: daemon poller (no CLI yet)

in startDaemon(), after socket server is set up:

    // telegram state (shared via closure)
    let tgWaiter = null;        // { resolve, reject, timer }
    let tgLastUpdateId = 0;
    let tgPollerActive = false;

    async function tgPoller() {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) return;
      tgPollerActive = true;
      while (tgPollerActive) {
        try {
          const url = `https://api.telegram.org/bot${token}/getUpdates`
            + `?timeout=25&offset=${tgLastUpdateId + 1}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
          const data = await res.json();
          for (const update of data.result || []) {
            tgLastUpdateId = update.update_id;
            const text = update.message?.text;
            const chatId = String(update.message?.chat?.id);
            if (text && chatId === process.env.TELEGRAM_CHAT_ID && tgWaiter) {
              const w = tgWaiter;
              tgWaiter = null;
              clearTimeout(w.timer);
              w.resolve(text);
            }
          }
        } catch { /* network error - retry after 5s */ }
        await new Promise(r => setTimeout(r, tgPollerActive ? 0 : 5000));
      }
    }

    if (process.env.TELEGRAM_BOT_TOKEN) tgPoller();

### phase 2: tg-send and tg-wait in handleCommand()

    case "tg-send": {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!token || !chatId) return { ok: false, error: "NO_TOKEN" };
      const msg = req.args?.message;
      if (!msg) return { ok: false, error: "message required" };
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: msg }),
      });
      return { ok: true };
    }

    case "tg-wait": {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!token || !chatId) return { ok: false, error: "NO_TOKEN" };
      if (tgWaiter) return { ok: false, error: "ALREADY_WAITING" };
      const msg = req.args?.message;
      const timeoutMs = req.args?.timeout ?? 60000;
      // send the message first
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: msg }),
      });
      // then wait for reply (returns a promise that handleCommand awaits)
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          tgWaiter = null;
          resolve({ ok: false, error: "TIMEOUT" });
        }, timeoutMs);
        tgWaiter = { resolve: (text) => resolve({ ok: true, reply: text }), timer };
      });
    }

NOTE: handleCommand() is already async. tg-wait returning a Promise works
because the caller `await`s the result before writing to the socket.
verify this is true in the current socket server loop before implementing.

### phase 3: CLI

in cli(), add to ALIASES if desired, then:

    if (command === "tg") {
      const flags = { reply: false, timeout: 60 };
      const parts = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--reply") { flags.reply = true; continue; }
        if (args[i] === "--timeout") { flags.timeout = parseInt(args[++i], 10); continue; }
        parts.push(args[i]);
      }
      const message = parts.join(" ");
      if (!message) { console.error("usage: p tg <message> [--reply] [--timeout <s>]"); process.exit(1); }

      if (!flags.reply) {
        const res = await sendCommand({ cmd: "tg-send", args: { message } });
        if (!res.ok) { console.error(res.error); process.exit(1); }
        process.exit(0);
      }

      const res = await sendCommand({ cmd: "tg-wait", args: { message, timeout: flags.timeout * 1000 } });
      if (!res.ok) {
        if (res.error === "TIMEOUT") { console.error("timeout: no reply"); process.exit(2); }
        console.error(res.error); process.exit(1);
      }
      process.stdout.write(res.reply + "\n");
      process.exit(0);
    }

---

## error cases

| error         | when                                     | agent sees          |
|---------------|------------------------------------------|---------------------|
| NO_TOKEN      | env vars not set in daemon's env         | exit 1, stderr msg  |
| daemon down   | daemon not running                       | "daemon not running"|
| TIMEOUT       | --reply, no response in N seconds        | exit 2              |
| ALREADY_WAITING | two agents both doing --reply          | second gets exit 1  |
| network error | telegram API unreachable                 | exit 1, stderr msg  |

---

## what NOT to build

- no MCP server wrapper (CLI is sufficient, agents can run shell commands)
- no HTTP endpoint (adds attack surface, unix socket is fine)
- no message history / database (not needed)
- no multi-user support (marco is the only user)
- no markdown formatting / keyboard buttons (plain text only, keep it simple)
- no persistent config file for token (env vars match existing pattern)

---

## agent prompt snippet (exact text to give the communication agent)

    you have access to a telegram command to message marco directly.

    send a notification (non-blocking):
      p tg "your message here"

    ask a question and wait for reply (blocking):
      REPLY=$(p tg "your question here" --reply --timeout 120)
      echo "marco said: $REPLY"

    exit codes: 0=ok, 1=error, 2=timeout (no reply)
    keep messages short. marco reads on mobile.

---

## files to modify

    lib/pty-manager.mjs
      - add TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID to SAFE_ENV_KEYS (line ~41)
      - add tgPoller() function near startDaemon()
      - add tg-send and tg-wait cases in handleCommand()
      - add `tg` command in cli() function
      - add `tg` to USAGE string

no new files. no new dependencies.
