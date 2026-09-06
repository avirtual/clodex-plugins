# stock-assessments

A sidebar button (`◳ Stocks`) that opens past equity research: tickers on the
left, dated runs in the middle, the document on the right — and, since 0.2.0,
the research pipeline that produces it.

Ticking this plugin on a seat gives that seat all four pieces at once: the
viewer, the `/stock-assessments:stock-research` skill, and the two subagents the
skill spawns. That is the point of carrying them together — a seat that can read
the library can also add to it, and there is no way to end up with a viewer whose
re-assess button names a skill the seat does not have.

Built for the layout the `/stock-research` skill writes:

```
<workspace>/assessments/<TICKER>/<YYYY-MM-DD>/assessment.md
                                             /fundamentals.p1.md
                                             /diligence.p2.md    …
```

Anything not matching that shape is skipped rather than guessed at.

## What it shows

- **Tickers** — latest score as a colour-banded chip, conviction, the newest
  run's date, how many runs exist, and a `▲/▼` delta against the previous run.
  The delta appears only when *both* runs parsed a score, so an unreadable
  header never reads as a fall to zero.
- **Runs** — newest first. Each lists its documents, `assessment.md` first,
  then the researcher findings that back it (`Fundamentals · pass 1` and so on).
- **Document** — rendered markdown: headings, lists, blockquotes, and the pipe
  tables the findings files use for financials.
- **Staleness** — a `stale · 97d` or `catalyst passed` chip on the ticker row.
  The workspace's re-assessment rule has four triggers; two of them (age ≥90
  days, a watchlist catalyst date that fell after the last run) are computable
  from files on disk, and only those two are implemented. Earnings dates and
  price-vs-SPY moves need data a viewer has no business fetching, so they are
  deliberately absent rather than approximated. **No chip does not mean not
  due** — the two missing triggers are the two most likely to fire.
- **Re-assess** — a button that types `/stock-research <TICKER>` into a
  session. See below; it is the one control here that spends money.

Score and conviction are pulled out of the assessment header with loose
patterns, because the corpus's header shape drifts between runs
(`**Score: 44/100 | Conviction: low**`, `**Score: 36/100 — conviction: LOW**`).
A header that does not parse yields a run card with no chips, never a missing
run.

**It never writes to the library.** Assessments are point-in-time documents —
the workspace rule is to write a new dated one rather than edit an old one — so
there is no edit or delete path. `Reveal` opens the run's folder in Finder if
you want to do something the viewer cannot.

## The quote header

Above the document, across the width of the reading pane: price, day change, a
price chart (1M/6M/1Y), the 52-week range with a marker for where price sits in it, market
cap, volume, day range and previous close. It follows the selected **ticker**,
not the selected document, so clicking through a run's findings files does not
refetch or repaint it. It is a quick look, not a terminal —
and it is deliberately **today's** number sitting next to a **dated**
assessment. Those are different moments; the header always stamps its own.

Two keyless public sources, both read-only:

- **Yahoo v8 chart** — price, ranges, volume, the daily series. No key, no
  account. Undocumented, so every field is treated as optional and a redesign
  is expected breakage rather than a bug.
- **SEC XBRL** — shares outstanding, which is what makes market cap. **Off
  until you enable it.** The SEC's fair-access policy asks callers to identify
  themselves, so the plugin sends a contact email you enter in settings, only
  to `sec.gov`. Leave it blank and everything else still works; market cap just
  reads `—`. The price source is never sent an address.

Shares outstanding takes whichever of the two XBRL tags was *filed* most
recently rather than a fixed preference: NIKE's cover-page `dei` value was last
filed in 2015 and is 40% low, while its `us-gaap` diluted count is current.

**Not shown: P/E and dividend yield.** The endpoint that used to carry them now
answers `Unauthorized`, and deriving a trailing P/E from XBRL quarterly EPS
gave 20.1 against a true 18.3 for NKE — the tags have gaps and fiscal-year
misalignment. A confidently wrong multiple in a research tool is worse than an
absent one.

### The chart

A bare sparkline is only a shape — scaled to its own extremes, a 76% decline and
a flat month draw identically. So it labels the high and low it is scaled to,
dashes a line at the period's opening price, dates both ends, and reads out
date, price and the move from the open under the cursor.

It is drawn in a stretched viewBox so it fits any pane width, which means
nothing inside the SVG can carry text or a stroke that must keep its
proportions: labels are HTML positioned over the plot, and strokes use
`vector-effect: non-scaling-stroke`.

### Three outcomes, never confused

A source that is refusing must not look like a source that is empty — the
distinction this workspace learned the hard way from a browser-driven plugin
that reported a throttled account as "no posts found".

| State | What you see |
|---|---|
| Live | the price, with `as of <time> · <exchange>` |
| Stale | the last good price, amber, `source unreachable` |
| Failed cold | no numbers, and the reason in words |

Quotes are cached in `<userData>/plugins/stock-assessments/market/` — 90
seconds in memory for a price, a day for shares outstanding, a week for the
ticker→CIK map. The disk copy is also what the stale path falls back to, so it
is kept past its TTL on purpose.

## Re-assess

The one control that causes work rather than displaying it. It uses `inject`,
which types into a session's input exactly as if you had typed it — so all it
can ever do is ask the agent, in that agent's own workspace, to run the skill.

Three properties of `inject` shape the design:

- **It cannot confirm delivery.** It returns `undefined` and is not async; you
  cannot learn whether the text arrived, queued behind a mid-turn hold, or hit
  a session that just died. So a click may produce no visible effect, and the
  natural response to that is to click again — into an expensive run.
- **A newline can split one message into several.** The command is a single
  collapsed line built from a ticker that has already passed the ticker
  grammar.
- **Non-strings are coerced, not rejected** — a bad value becomes visible text
  in your prompt.

What follows from that:

- **Only this window's active session** is ever offered, and only when it is a
  live `claude` seat whose working directory resolves to the library on screen.
  Not a session picker: choosing a session for you would mean guessing which
  agent absorbs an expensive run, and could write `assessments/` into an
  unrelated repo. If the active session does not qualify, the button is
  replaced by a greyed line saying which reason applies.
- **Confirmation first**, naming the exact line and the session receiving it.
- **A 15-minute cooldown** replaces the button with `↻ requested 4m ago`. It is
  enforced in the engine, not just the UI: every window draws its own button
  from its own last listing, so a second window would otherwise still show one.
  The wording is deliberate — the record is that the request was *sent*, which
  is the most that is knowable.
- **Only tickers already in the library.** This is a re-run button, not a
  research-anything box; the ticker must have an existing assessments folder.

## What it carries

Three content entries beside the two code halves, namespaced by the plugin id
because that is how the loader exposes a bundle:

| On disk | Reached as |
|---|---|
| `skills/stock-research/SKILL.md` | `/stock-assessments:stock-research <ticker> [quick]` |
| `agents/stock-researcher.md` | `stock-assessments:stock-researcher` |
| `agents/stock-assessor.md` | `stock-assessments:stock-assessor` |

The skill is the coordinator: it spawns three researchers (fundamentals,
diligence, catalysts), has them peer-review each other's round-1 files, then
hands the lot to the assessor, which writes the scored `assessment.md` and
updates `watchlist.md`. The coordinator reads no research content itself, which
is what keeps a full run from filling the operator's session with prose.

**The namespace is why the re-assess button changed.** A bundled skill is
invoked as `/<plugin-id>:<skill>`; the bare `/stock-research` would resolve only
against a copy in `~/.clodex/skills/`. Both halves now name the namespaced form,
so the button depends on nothing outside this directory. If you keep a library
copy as well, the two are independent files and will drift — prefer one.

**Content arrives at a seat's next start.** Ticking the plugin mid-session
grants the viewer immediately but not the skill or the agents: bundle content is
written at spawn. Until that seat restarts, the re-assess button types a skill
name the seat cannot resolve — which fails visibly, rather than silently running
some other copy.

## Which folder it reads

In order:

1. **A folder you chose** — `Folder…` in the overlay, or the path field under
   `Manage Plugins… → Stock Assessments → Settings`. If it is set but has no
   `assessments/` inside it, you get an error naming the path. It does *not*
   quietly fall back to the session, because reading a different library than
   the one you named is worse than showing nothing.
2. **The active session's working directory**, walking up to four levels
   looking for an `assessments/` folder. So a session rooted anywhere in the
   stocks workspace finds it, and a session in an unrelated project finds
   nothing.

A session on a peer machine is refused by the host (`fsScope`) — there is no
local filesystem to read.

Everything is re-read on each open. Nothing is cached, so a research run that
finishes while the overlay is closed shows up the next time you open it.

## Installing

The directory name is the plugin id and they must match — keep it named
`stock-assessments`.

Clodex → Plugins → **Register Plugin…** → pick this folder. That is the route
to use: it records where the link points and gives the row an Unregister
button. Hand-symlinking into `~/.clodex/plugins/` and pressing Re-scan also
works, but the plugin is then discovered with no provenance and has to be
removed by hand.

It contributes no `[agent:…]` verb, so there is no Intents row to tick. There
is still a per-seat step: a plugin loaded from `~/.clodex/plugins` is off by
default on every seat, and reaches one only when that seat's Plugins list
includes it (`⚙ session ▾ → 🔌 Plugins…`). Tick it on the stocks seats; leave
it off everywhere else, which is the point of the default.

The renderer half is desktop-only — registered external plugins get no UI on
the web surface.

### It spends money

Worth knowing before you tick it on a seat: this is a viewer **and** a research
pipeline. The re-assess button injects `/stock-assessments:stock-research
<TICKER>` into a session, and a full run spawns three researcher subagents,
peer-reviews their findings, then spawns an assessor — real tokens, several
minutes. The button is deliberately hard to fire by accident (active session
only, confirmation naming the exact line, a 15-minute cooldown), but it is the
one control here that costs anything.

The viewer alone is read-only and free. If you only want to browse a library
someone else produced, leave the seat's re-assess path unused; the skill and
subagents are inert until the skill is invoked.

### Capability checks

Both halves check the host APIs they need at activation and throw a named error
naming the missing one. `hostApi` is `"1"` on every host that will run this and
new APIs arrive additively, so the manifest cannot express "needs a recent
Clodex" — an older host would otherwise fail with a `TypeError` from somewhere
unhelpful and be held back after two launches with nothing readable in the log.
Two renderer APIs (`ui.openPath`, `ui.pickDirectory`) are checked at the point
of use instead, so a host missing them loses one button rather than the viewer.

## Shape

- `engine.js` — path resolution, the directory walk, header parsing, file
  reads. Every renderer-supplied segment is grammar-checked and prefix-checked
  before it is joined to a path, and reads additionally resolve symlinks and
  refuse anything landing outside the assessments tree.
- `renderer.js` — the overlay, the footer button, the settings section, the
  staleness chips, the re-assess control, and a small markdown renderer that
  builds DOM nodes and sets every leaf through `textContent`. These documents
  are model-written prose; none of it becomes markup.
- `market.js` — the only part that reaches the network, and the first engine
  half in this collection to make an outbound HTTP call at all (the `github`
  plugin shells out to an authenticated `gh` instead; that pattern does not
  apply to a keyless public endpoint). Kept out of `engine.js` for
  that reason. Plain Node `fetch`, no dependency, hard timeout
  and a response cap; every failure returns a result rather than throwing,
  because an unreachable quote source is an expected condition here.
- `style.css` — all selectors `sa-`-prefixed; plugin CSS is injected unscoped.
  The quote header uses only theme variables (`--ok`/`--error` for direction,
  `--accent` for the range marker), so it stays readable on the light themes.
- `skills/`, `agents/` — content, not code. Undeclared in the manifest: the
  loader reads the directories. Verify with
  `node ~/projects/clodex/plugins/tools/verify.js <this dir>`, which prints the
  bundle entries it accepted — the only way to catch a name the loader skipped,
  since an `agents/*.md` typo is ignored with no log line at all.
