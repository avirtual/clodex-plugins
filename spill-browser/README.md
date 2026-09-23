# spill-browser

Read the bodies Clodex filed out of seats' transcripts. When a long intent body
(`dm`, `shout`, `task add`, `task done`, …) or a long stretch of prose after a
seat's last intent is cut from its transcript, Clodex keeps it as a markdown file
under `~/.clodex/spill/<agent>/`. This overlay lists them newest first — `time ·
agent · kind · size · head or first line` — filters by kind and by agent, and
renders the one you click as markdown.

**Seat**: any one seat. The overlay reads every agent's spills whichever seat
holds it, so hold it on the one you keep open.

**Writes**: nothing. It reads the spill folder, the diag log and the ticket
boards, and keeps what it learns in memory only.

## Before it shows anything: two switches

1. **Enable the plugin** in **Plugins ▸ Manage Plugins…** — it ships off.
2. **The seat must hold it** — tick `spill-browser` in the session's 🔌 Plugins…
   list. The **⤓ Spills** button then appears in the sidebar footer.

No capability grant is needed: it reads files, not agents' turns.

## Where the data comes from

- **Bodies** — `~/.clodex/spill/<agent>/<id>.md`. The id is a content hash, and
  the file is the raw body with no header, so neither the name nor the file says
  when it was filed or what it was.
- **Metadata** — `"type":"wire-spill"` rows in `~/.clodex/wire-shadow-diag.jsonl`
  carry the time, the verb (`prose` for tail prose) and the intent's head line.
  The plugin joins them to the files on agent + id. The file is append-only and
  kept forever, so it is read once and then only from where the last read
  stopped.

Two mismatches you will see:

- **A file with no index row** lists as kind `unknown`, dated by the file's
  mtime. Spills from before the index carried them are like this. The
  exception is a scratch episode's result: core files it with no index row,
  but its first line (`Scratch episode result …`) names it, so it lists as
  kind `scratch`.
- **An index row with no file.** Core deletes a seat's spill folder with the
  seat, and the ticket loop retires every hand when its ticket is accepted — so
  most `task done` files are gone. `task` bodies also live in the ticket boards
  (`~/.clodex/projects/*/tickets.json`: spec, respecs, report, review rounds,
  rework reasons), so for a `task …` row whose file is gone the plugin looks for
  the body there. The spill id is the body's content hash, so a match is
  exact rather than a guess. A recovered row lists normally, and the reader
  marks it *from ticket record t…*. Anything else with no file — a `dm` or
  `prose` from a deleted seat — does not list; there is nothing to read.

The same body filed twice is one file (the name is its hash), so it shows once,
at its latest filing.

## Live updates

A plugin cannot hear core's own `spill` message, so the engine watches the diag
file and pings open windows when a new `wire-spill` row lands. If the watch
cannot be set up the list still refreshes each time you open the overlay.

## Browser client

`list` and `read` are both callable from the browser client: they take no host
path, only an agent name and a 16-hex id, and every read is resolved and checked
to stay inside `~/.clodex`.

## License

Apache-2.0.
