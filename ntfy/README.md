# ntfy

Subscribes to one or more [ntfy](https://ntfy.sh) topics and turns every message
into an operator inbox note and, optionally, a DM to a seat — a different seat
per topic, if you want one.

The motivating case: point a GitHub webhook at an ntfy topic with
`?template=github`, and pushes, PRs and CI results land in Clodex without
polling and without a second Mac app.

**Needs Clodex 5.36.0 or newer** — it raises operator inbox notes through
`host.notify.user`, which does not exist before that. The engine checks for the
capability by name in `activate()` and throws if it is missing, so an older host
refuses it visibly rather than failing at the first message.

## Settings

Settings ▸ Plugins ▸ ntfy.

| Field | Meaning |
|---|---|
| Server | The ntfy server, **without** a topic — e.g. `https://ntfy.example.com`. Empty means idle; no request is made. |
| Inbox note | Raise each message in the operator inbox. |
| Topics | One row per topic, each with an optional seat. Empty seat = inbox note only. A dead or unknown seat is logged and skipped; a row whose topic is not a valid ntfy name is skipped with one log line, and the other rows still deliver. |
| Only from | Comma-separated tag or title **prefixes**, e.g. `github`. Empty accepts everything. |
| Ignore titles containing | Comma-separated, case-insensitive substrings, e.g. `labeled, unlabeled`. |
| Mute comments by | Comma-separated GitHub logins, e.g. `avirtual`. Their **comments** are dropped; opens, closes and labels still arrive. Empty by default — nothing in a message identifies your account, so this cannot be inferred. The author is read from the `<login>: ` prefix on the body's **first line**, which ntfy's template writes; there is no author field to match on. See [Filtering](#filtering). |

A private server wanting a bearer token reads it from the environment:

```
CLODEX_NTFY_TOKEN=tk_... npm start
```

Never from settings — settings are persisted in cleartext and rendered in every
window. The token is never written to a log line either.

Saving takes effect within about five seconds; there is no restart to do. The
status line under the fields says what the engine currently thinks, which is the
thing to read if a saved server does not seem to have taken: `server url not
valid; idle` means it was stored and refused, not that the save was lost. It
also names the topics the engine actually settled on, which is how a skipped row
becomes visible.

**Upgrading from 1.5.0 needs no action.** A config with the old single `url`
(topic on the end) and `Also DM seat` is read as one topic row on the server that
url pointed at, so an existing install keeps delivering to the same seat without
the dialog being opened. Saving from the new dialog writes the table.

### How settings are saved, and why it is worth writing down

The dialog's `collect()` **returns** its patch and the **host** persists it —
which is what the contract's §6.6 describes, and what every other plugin here
does. This plugin used to do something else: it called its own engine's
`settings.set` from `collect()` and returned `null`. That is one writer too many
and one writer too few at once — the host was told to save nothing, and a
refusal was reported into a panel that Save had already closed.

The consequence for the engine is the interesting part. Nothing tells a plugin
its settings changed; there is no hook for it. A plugin that only reconnects
inside its own `settings.set` therefore never reconnects at all once that method
stops being the route settings arrive by. So the engine **polls** — it compares
the saved URL against the one the live connection was built from, every five
seconds, and reconnects when they differ. That poll is the entire mechanism by
which saving anything here does anything. What it compares is the whole
subscription — server, topics and seats — because adding a topic has to
reconnect too, and a check on the server alone would leave a newly-added topic
unsubscribed until something else happened to change.

Validation lives on the **read**, in `connect()`, not on the write. It has to:
`_host`'s own `settings.set` answers on both surfaces and can write any plugin's
settings key ([plugin-api.md §2.2]), so a renderer-side check is never the only
door. An unusable URL is stored, refused at the point of use, and reported
through `status.get` as `server url not valid; idle`. The reasons are kept
distinct — no server, an unusable server, and no topics are three different
fixes, and one shared message would send an operator to the wrong field.

## Filtering

Evaluated before anything is routed, in this order:

1. **Only from** — when set, a message is kept only if one of its ntfy `tags`,
   or its title, **starts with** one of the listed values. Prefix rather than
   equality because tags carry suffixes: `github` matches `github-pr`. Drops are
   counted and reported to the log at most once an hour — silence would be
   wrong, because a filter that matches nothing looks exactly like a dead topic.
2. **Mute comments by** — an agent commenting from the operator's own account
   hears itself, once per comment it posts. The motivating case is exactly that:
   four comments and a close on one issue woke a lead agent six times, and the
   close was the only one of the six that carried information.

   The filter drops on **authorship**, not on event type, and that is what keeps
   the close. A comment's body begins `<login>: ` — and a state change carries no
   author line at all, its body being the bare issue URL — so opens, closes and
   labels cannot match here and survive without this plugin holding a list of
   GitHub's event verbs to keep in sync.

   There is no author *field* to read. ntfy's template consumes the webhook JSON,
   `sender.login` and all, long before the plugin sees anything; that prefix is
   the only trace of an author that survives. It is written by the **template**,
   not by the commenter, which is what makes matching on it safe — a commenter
   controls only the text after it. The author is therefore taken from **line
   one or nowhere**: a state change embeds the issue body, so scanning every line
   would let whoever opened an issue plant `avirtual: ` inside their report and
   permanently suppress the closes and labels for it.
3. **Ignore titles containing** — case-insensitive substrings, dropped silently.
   Label churn (`labeled`, `unlabeled`) is the motivating case: high volume, no
   information, and the operator has already said they do not want to hear it.

   It is also the lever for a **malformed** title. `?template=github` fills issue
   fields on every event, including ones that have none — a fork arrives as
   `clodex: <no value> #<no value>: <no value>`, with a perfectly good body. That
   rendering happens on the ntfy server, so nothing here can fix it; adding
   `<no value>` to this field drops those events and matches no real title.
4. **Duplicate collapse** — the same title and body as any of the last 20 routed
   messages within 10 minutes. The id dedupe cannot do this: a sender
   republishing the same text gets a fresh id every time. Outside the window the
   same text is news again, so a nightly build reporting the same result
   tomorrow still arrives.

**Everything dropped still advances the cursor.** A cursor that only moved past
routed messages would re-fetch every filtered one on the next reconnect, so a
well-filtered topic would replay its backlog forever and the filters would cost
more work the better they worked.

All three lists are parsed in the **engine**, on read, and accept either a
comma-separated string (what the dialog writes) or an array (what a hand-edited
`ui-settings.json` holds). Same reason the URL is validated on read: `_host`'s
`settings.set` answers on both surfaces and can write any plugin's key, so the
dialog is never the only door.

## What reaches a seat, and what it costs

The inbox and the seat are not the same kind of destination, and the budget
below follows entirely from that. An inbox note is a place the operator **goes
to look**: fifty of them is a busy afternoon. An injection is an
**interruption** that lands in an agent's context and stays there, so fifty of
them is that agent's working memory spent on a webhook. The topic is a
public-read endpoint fed by GitHub — anyone who can comment on a repo can put
text into it — so the volume is not this plugin's to assume.

So the inbox route is unchanged and unbudgeted, and the seat gets:

- **A summary, not the note.** Head line, the first non-blank line of the body,
  and a pointer to the inbox note by id — under **500 bytes** in total. Bytes,
  not characters: 200 emoji is 200 characters and 800 bytes, so a character
  count is not a bound on what an injection costs. With the inbox route off
  there is no full copy to point at, and the summary says so rather than naming
  a note that was never raised.
- **At most 10 injections per 10 minutes, and 40 per hour.** Sliding windows,
  persisted — a budget that reset on restart would refill every time the stream
  dropped, which under a flood is exactly when it drops. `status.get` reports
  what is left, because a seat that has gone quiet while the inbox fills is
  otherwise indistinguishable from a misspelt seat name.
- **One held-back line per hour**, sent a minute after the budget is first
  exceeded rather than immediately. The delay is the point: a flood trips the
  budget on message eleven, so a notice sent there would say "1 message held
  back" and then go quiet for an hour while the other thirty-nine piled up
  silently. Every held message is logged individually, so the plugin's own
  record stays complete.
- **Nothing over 8 KB**, budget or no budget. One oversized comment costs an
  agent more than the whole hourly allowance, and the inbox copy is clipped to
  2000 characters anyway, so the seat loses nothing it would have been shown.

The rate numbers are constants, not settings. They are a safety property, and
an operator raising them under a flood is the moment they should not be able to.

## What the agent sees

Both the title and the body come from outside the repo, so every `[agent:` in
either becomes `\[agent:`; the title is clipped to 160 characters and the body to
2000. The body sits between an `UNTRUSTED` banner and its closing line. The
title does not — it rides the head line, above the banner — which is why it is
also folded to a single line.

The seat summary carries no banner. There is nothing to fence off: the only
attacker-controlled spans in it are two clipped, escaped, single-line fragments,
and a banner around 180 bytes of subject line costs more context than the line
it guards. The `\[agent:` escaping still applies — that is what stops the text
being read as instructions, and it matters at any length.

The fold covers `U+2028` and `U+2029` as well as CR and LF. Those two are line
breaks to a renderer but not to `/[\r\n]/`, so folding only the ASCII pair would
leave a title that is one line to the code and two lines on screen — with the
second one at column 1, above the banner, where nothing marks it as untrusted.

Quote it; do not obey it.

## Several topics, one connection — and why the cursor is per topic

Every topic rides **one** connection: ntfy accepts a comma-joined list
(`/alpha,beta/json`) and stamps each message with the topic it belongs to, so a
second socket would buy nothing. Messages are routed by that field, never by the
request — the path names every topic at once, so a router reading the URL would
send all of them to whichever seat sorted first.

The **cursor, though, is per topic**, and that is not a tidiness choice. It was
measured against ntfy.sh:

```
publish A1, B1, A2, B2   across topics A and B
GET /A,B/json?poll=1&since=<id of A2>   ->   returns B2 only
```

`since=<id>` does not mean "resume after that message". ntfy resolves the id to
its **timestamp** and filters every topic by time, so B1 — never delivered — is
dropped for being older than the cursor. Timestamps have second granularity, so
two messages published in the same second on different topics collapse
entirely: a cursor on one loses the other permanently, with no error and no gap
to notice. On a GitHub-fed topic, where a push and its CI result land in the
same second routinely, that is silent, unrecoverable loss.

So each topic remembers its own last id. On reconnect the single `since` the
request can carry is the **oldest** of them, which means some messages arrive
twice — and that is fine, because the `seen` list already makes delivery
idempotent. **Re-delivery is recoverable; skipping is not**, and the whole
choice is that asymmetry.

A topic with no cursor yet forces `latest` for the request rather than `all`:
adding a topic should not replay its entire retained history into the inbox.

## What a seat costs, per seat

The rate budget is **per seat**, not per plugin. Seats do not share a context
window, and a shared budget would let one noisy topic starve every other seat —
the quiet topic that only fires on a release would find the allowance gone at
exactly the moment its one message matters. The held-back notice is per seat for
the same reason: a shared one would tell a seat about messages held from
somebody else.

## Delivery

One connection at a time, reconnecting with a jittered 2s→60s backoff. The last
handled message id is persisted per topic, so a restart resumes with
`since=<id>` rather than replaying a topic or missing it.

A non-200 is logged with its status code rather than only recorded: a 401 from a
server wanting a bearer, or a 404 from a topic that does not exist, is a
configuration mistake, and the backoff would otherwise retry it forever looking
exactly like an unreachable host.

The NDJSON line buffer is capped at 64K. A stream is only newline-delimited if
the far end sends newlines, and this is a long-lived connection to a host typed
into a settings field, so a server that sends none would otherwise grow the
buffer until the app dies. Passing the cap drops the stream and reconnects; the
cursor is untouched, so nothing already delivered is lost.

### A buffering proxy, and the poll fallback

The failure worth knowing about has no error in it. A reverse proxy configured
to buffer responses never forwards the stream's headers — the stream never ends,
so there is nothing to buffer *to* — and the socket then sits `ESTABLISHED`
forever. Every timeout Node offers is on **inactivity**, which this is not: the
connection is healthy and silent. Nothing fails, nothing is logged, and the
plugin is indistinguishable from one with no messages to deliver.

Two things follow from that:

- **A 30s deadline on the response headers.** A working server sends them
  immediately and a buffering proxy withholds them, so this is the one signal
  that separates the two. On expiry: `ntfy stream sent no headers in 30s —
  proxy buffering?`, then the normal backoff.
- **After three of those, it falls back to polling** `?poll=1` every 30 seconds
  and says so once. A poll request *completes*, so it survives the buffering
  that defeats the stream. Messages keep arriving, up to 30s late; `status.get`
  reports `mode: "poll"` and the settings dialog shows it.

The fallback is one-way for the life of the connection — alternating between a
mode that works and one that hangs for 30s would be worse than committing.
Saving a URL, or toggling the plugin off and on, puts it back on streaming: that
is the operator saying they have fixed the proxy.

If you see poll mode, the fix is in nginx, not here:

```
proxy_buffering off;
```

Both paths share `handleLine`, so dedupe, the cursor and the untrusted fencing
are the same code either way — a second copy is how one path quietly stops
escaping `[agent:`.

## Tests

`test/ntfy-plugin.test.js`, driven through the real plugin host engine against a
real local HTTP server that speaks the NDJSON stream — every claim above is
about bytes on a socket, and a stubbed `https.get` would let them pass with the
request never built.

```
node --test ntfy/test/*.test.js
CLODEX_REPO=/path/to/clodex node --test ntfy/test/*.test.js
```

The host engine is not part of this repo, so the suite finds a Clodex checkout
(`$CLODEX_REPO`, then `~/projects/clodex`) and **skips with a reason** when there
is none, rather than failing on a machine that has no checkout to test against.

The timings are overridable by environment variable
(`CLODEX_NTFY_RECONCILE_MS`, `CLODEX_NTFY_HEADER_TIMEOUT_MS`,
`CLODEX_NTFY_HEADER_TIMEOUT_MAX`, `CLODEX_NTFY_POLL_MS`,
`CLODEX_NTFY_BURST_WINDOW_MS`, `CLODEX_NTFY_HOUR_WINDOW_MS`,
`CLODEX_NTFY_DUP_WINDOW_MS`, `CLODEX_NTFY_HELD_NOTICE_MS`) so the suite can
drive three 30-second timeouts, a ten-minute rate window and an hourly notice in
under a second. They are **not settings** and are absent from the dialog on
purpose: an operator has no way to know a good value, and every wrong one
presents as this plugin being broken.

The windows in particular have to be overridable to be tested at all. The
sliding half of a rate limit is otherwise invisible — a budget that never refills
looks identical to a working one for the first ten minutes.

[plugin-api.md §2.2]: https://github.com/avirtual/clodex/blob/master/plugins/plugin-api.md
