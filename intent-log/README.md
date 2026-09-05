# intent-log

A live feed of the `[agent:…]` intents your seats emit — `time · agent · verb ·
argument`, every granted seat in one window, across workspaces. Filter by verb
or by agent, pause to read, clear to reset.

**Seat**: hold it on one seat you keep open — the overlay shows every granted
seat's intents regardless of which one you are looking at, so a single "console"
seat is the natural home. Grant it on each seat you want to *watch*.

**Writes**: nothing. The feed is a 500-line in-memory ring that dies with the
app. No files, no settings, nothing to clean up afterwards.

## Before it shows anything: two switches

Both default to off, and until both are on a seat contributes nothing —
silently, so check both before concluding it is broken.

1. **The seat must hold the plugin** — tick `intent-log` in the session's
   🔌 Plugins… list.
2. **The session must grant `turns`** — its Intents popover, under *Plugin
   Access*. Per session, default off.

Revoking the grant stops that seat appearing from its next turn onward.

## What it shows, and what it cannot

Intents are parsed out of the agent's visible text, which is the same string the
host itself scans. So the feed shows **what an agent wrote**, not what the host
did with it:

- A refused intent still appears — a bounced `dm`, an `exec` whose payload was
  rejected, a verb the seat was never granted. What you are watching is
  intention, not outcome.
- A **fenced** intent line (inside ``` ```` ```) and a `\[agent:…]` escape are
  skipped, matching the host's own rule that both are quotes rather than acts.
- `[agent:end]` is a body terminator, not an act, so it is not listed. Inbound
  `[agent:from …]` and `[agent:peers]` lines are the host talking to the agent,
  not the agent acting, and are skipped too.
- Only the **main line** is heard: a subagent's intents never arrive, so a
  Task-heavy seat shows the coordinator's acts and not its subagents'.
- An intent an agent emits while a seat has no grant is invisible, permanently —
  the feed is live only, and nothing is backfilled when you grant it later.

Argument previews are clipped to 120 characters on one line. `dm`, `task`,
`exec` and `term` are tinted, being the four that change something outside the
seat that emitted them.

## Duplicates

Delivery is at-least-once — when the wire's observer fails for a request, Clodex
replays that turn's tail from the transcript — so the same line can arrive
twice. Repeats are suppressed on content, 64 per session. Two genuinely
identical intents from one agent, separated by more than 64 others, would show
once.

## Requirements

Needs a Clodex providing `host.sessions.onAgentText`. On an older one the plugin
throws at activation naming that capability rather than half-loading. The
manifest declares `"scope": "session"`, which is what makes the grant rows exist
at all — a `global` plugin is offered no capabilities and receives nothing.

## Status

Written as a working exercise of the turn-text feed: the intents are re-parsed
for **display only**, so a line this plugin misreads changes nothing about what
the host ran. Treat it as a monitor, not as an audit log — it has no persistence
and does not claim completeness.

## Installing

Register this folder (**Plugins ▸ Manage Plugins… ▸ Register Plugin…**), or by
source spec once your Clodex offers that:

```
avirtual/clodex-plugins:intent-log                       # follows the default branch
avirtual/clodex-plugins@intent-log-v0.1.0:intent-log     # frozen, never updates
```

## License

Apache-2.0.
