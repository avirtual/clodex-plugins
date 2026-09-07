# ntfy

Subscribes to an [ntfy](https://ntfy.sh) topic and turns every message into an
operator inbox note and, optionally, a DM to one seat.

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
| Topic URL | The full topic URL, e.g. `https://ntfy.example.com/clodex`. Empty means idle — no request is made. |
| Inbox note | Raise each message in the operator inbox. |
| Also DM seat | A session name to inject each message into. Empty for none; a dead or unknown seat is logged and skipped. |

A private server wanting a bearer token reads it from the environment:

```
CLODEX_NTFY_TOKEN=tk_... npm start
```

Never from settings — settings are persisted in cleartext and rendered in every
window. The token is never written to a log line either.

Saving takes effect within about five seconds; there is no restart to do. The
status line under the fields says what the engine currently thinks, which is the
thing to read if a saved URL does not seem to have taken: `url not valid; idle`
means it was stored and refused, not that the save was lost.

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
which saving a URL does anything.

Validation lives on the **read**, in `connect()`, not on the write. It has to:
`_host`'s own `settings.set` answers on both surfaces and can write any plugin's
settings key ([plugin-api.md §2.2]), so a renderer-side check is never the only
door. An unusable URL is stored, refused at the point of use, and reported
through `status.get` as `url not valid; idle`.

## What the agent sees

Both the title and the body come from outside the repo, so every `[agent:` in
either becomes `\[agent:`; the title is clipped to 160 characters and the body to
2000. The body sits between an `UNTRUSTED` banner and its closing line. The
title does not — it rides the head line, above the banner — which is why it is
also folded to a single line.

The fold covers `U+2028` and `U+2029` as well as CR and LF. Those two are line
breaks to a renderer but not to `/[\r\n]/`, so folding only the ASCII pair would
leave a title that is one line to the code and two lines on screen — with the
second one at column 1, above the banner, where nothing marks it as untrusted.

Quote it; do not obey it.

## Delivery

One connection at a time, reconnecting with a jittered 2s→60s backoff. The last
handled message id is persisted, so a restart resumes with `since=<id>` rather
than replaying the topic or missing it.

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
`CLODEX_NTFY_HEADER_TIMEOUT_MAX`, `CLODEX_NTFY_POLL_MS`) so the suite can drive
three 30-second timeouts in under a second. They are **not settings** and are
absent from the dialog on purpose: an operator has no way to know a good value,
and every wrong one presents as this plugin being broken.

[plugin-api.md §2.2]: https://github.com/avirtual/clodex/blob/master/plugins/plugin-api.md
