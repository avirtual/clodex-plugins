# turn-log

Records what agents say to a per-session log on disk, and gives you a sidebar
overlay to browse and search it. The answer to "what did that agent do while I
was in another window?"

**Seat**: any seat whose output you want kept. It records per session, so hold it
on the seats worth a record rather than everywhere.

**Writes**: `<userData>/plugins/turn-log/logs/<session>.jsonl`, one JSON object
per line, **plain text** — the agent's words as it wrote them. A log rotates
once at 5 MB (to `<session>.jsonl.1`, the previous file kept and no further
history). Nothing is written anywhere else, and nothing is sent anywhere.
**Reveal** in the overlay opens the folder; **Clear** deletes one session's log
and its rotated file.

## Before it records anything: two switches

Both default to off, and until both are on this plugin does nothing at all —
silently, which is the confusing part, so check both before concluding it is
broken.

1. **The seat must hold the plugin.** Tick `turn-log` in the session's
   🔌 Plugins… list (or the Intents popover's *Plugins* section).
2. **The session must grant `turns`.** In that session's Intents popover, under
   *Plugin Access*, grant Turn Log the `turns` capability. Grants are per
   session and default off.

Revoking the grant stops the recording from the next turn onward. Nothing
already written is removed — use **Clear** for that.

## What lands in the log

One row per event, and events arrive **per request, not per turn** — one user
turn is several requests, so expect several rows for what you think of as one
answer. Rows carry `at`, `session`, `source` (`wire` or `jsonl`), `isTurnEnd`,
`truncated`, the paths the turn wrote, and the text.

`isTurnEnd` is `true`, `false`, or **`null` meaning not known**: sessions read
from a transcript rather than the wire have no turn-end signal, so `null` is an
honest gap rather than a "no". The overlay marks only a literal `true`.

You hear the **main line only** — subagent turns and side-calls never arrive, so
a Task-heavy session logs the coordinator's words and not its subagents'.

**Thinking blocks and tool inputs are not recorded.** They are separate
capabilities (`thinking`, `toolInputs`) that this plugin neither requests nor
receives; granting `turns` does not expose either.

## Duplicates

The feed is at-least-once: when the wire's observer fails for a request, Clodex
replays that turn's tail from the transcript, so text can arrive twice. The
plugin suppresses a repeat by hashing the text and remembering the last 64
hashes per session (configurable). A duplicate separated by more than 64
intervening events would be written twice.

## Settings

In **Manage Plugins ▸ Turn Log ▸ Settings**: the rotation size in MB, and the
duplicate-suppression window. Both apply to the next event; neither rewrites
what is already on disk.

## Requirements

Needs a Clodex providing `host.sessions.onAgentText`. On an older one the plugin
throws at activation with that sentence rather than half-loading, and Manage
Plugins shows it as not running. (Two consecutive failed launches hold a plugin
back until you press Retry — that is the host's rule for any plugin that throws.)

The manifest declares `"scope": "session"`, which is what makes the grant rows
appear at all: a `global` plugin is offered no capabilities and receives nothing
from the feed, permanently.

## Installing

Register this folder locally (**Plugins ▸ Manage Plugins… ▸ Register Plugin…**),
or by source spec once your Clodex offers that:

```
avirtual/clodex-plugins:turn-log                     # follows the default branch
avirtual/clodex-plugins@turn-log-v0.1.0:turn-log     # frozen, never updates
```

## Privacy

This plugin writes your agents' output to unencrypted files in your user data
directory, and anything an agent says — a key it echoed, a file it quoted —
lands there in the clear. That is what it is for, and the reason both switches
above default to off and are per session. Turning the plugin off stops new
writes; it does not delete what exists.

## License

Apache-2.0.
