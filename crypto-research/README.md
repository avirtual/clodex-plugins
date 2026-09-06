# crypto-research

A sidebar button (`◈ Crypto`) that opens crypto research: tickers on the left,
dated runs in the middle, the document on the right, with a live price header —
and the research pipeline that produces it.

Ticking this plugin on a seat gives that seat four things at once: the viewer,
the `/crypto-research:crypto-research` skill, the two subagents that skill
spawns, and the `[agent:cryptowatch]` verb. That is the point of carrying them
together — a seat that can read the library can also add to it.

Built for the layout the skill writes:

```
<workspace>/research/<TICKER>/<YYYY-MM-DD>/assessment.md
                                          /meta.json
                                          /fundamentals.p1.md
                                          /narrative.p1.md    …
```

Anything not matching that shape is skipped rather than guessed at: a directory
that is not a plausible ticker, a run folder that is not a date, a file that is
not `.md`.

## What it shows

- **Tickers** — the latest score as a colour-banded chip, conviction, the newest
  run's date, how many runs exist, and a `▲/▼` delta against the previous run.
  The delta appears only when *both* runs parsed a score, so an unreadable
  header never reads as a fall to zero. A `stale · 97d` chip past 30 days.
- **Runs** — newest first, each listing its documents with `assessment.md`
  first, then the findings that back it.
- **Document** — rendered markdown: headings, lists, blockquotes, fences, and
  the pipe tables the assessments use for catalysts.

Score and conviction are pulled from the assessment header with loose patterns,
because the corpus drifts between runs (`**Score: 41/100 | Conviction: medium**`
and `**Score: 58/100 — conviction: LOW**` both parse). A header that does not
parse yields a run card with no chips, never a missing run.

**It never writes to the library.** Assessments are point-in-time documents —
the rule is to write a new dated one rather than edit an old one — so there is
no edit or delete path in the viewer.

## The price header

Above the document: price, 24h/7d/30d change, market cap, FDV, volume, float
percentage, ATH drawdown, Fear & Greed, and a price chart (30d/90d/1y). It
follows the selected **ticker**, not the selected document, so clicking through
a run's findings does not refetch it.

It is deliberately **today's** number sitting beside a **dated** assessment.
Those are different moments, and the header says so and stamps its own.

Two keyless public sources, both read-only, no account and no key:

- **CoinGecko** — search, `/coins/markets`, `/market_chart`.
- **alternative.me** — the Fear & Greed index, as market context.

### An id is not a ticker, and the UI says which one it has

`/coins/markets` answers **200 with the token simply absent** when it does not
recognise an id. It does not error and it does not say which of the ids you
asked for it dropped — so a wrong id is indistinguishable from a token with no
data unless you check the response for the id you asked for. Every call here
does, and reports a bad id as a *resolution* failure rather than as empty data.

A symbol is not an identity either. Searching `WELL` also returns
`swell-network` and `wells-fargo-ondo-tokenized-stock`; on other tickers a dead
fork outranks the live protocol. So:

- a run that recorded its `meta.json` id uses it, and the header is silent;
- a ticker with no recorded id is resolved by search rank, and the header
  carries an **`id guessed`** chip naming what it picked and what else matched.

The chip is not decoration. It is the difference between a price you can trust
and a price for a different asset with a similar name.

### Three outcomes, never confused

A source that is refusing must not look like a source that is empty.

| State | What you see |
|---|---|
| Live | the price, with `as of <time>` |
| Stale | the last good price, amber, `source unreachable` |
| Failed cold | no numbers, and the reason in words |

Quotes are cached in `<userData>/plugins/crypto-research/market/` — 90 seconds
in memory for a price, an hour for a chart, a week for a resolved id. The disk
copy is also what the stale path falls back to, so it is kept past its TTL on
purpose. **Identity is deliberately not cached with the data**: two callers can
reach one coin by different routes, and caching it would let a run's confident
id suppress another ticker's `id guessed` warning.

CoinGecko's free tier throttles hard; a 429 is reported as a rate limit in
words, not as missing data.

## The `[agent:cryptowatch]` verb

An agent records a dated thing to watch, and it shows on that ticker's runs
column:

```
[agent:cryptowatch WELL 2026-09-12] Borrow caps lift. The real read is whether
TVL keeps falling AFTER caps lift — part of the drop to here was mechanical.
[agent:end]
```

The date is optional; the reason is not. Items due within 7 days get an accent
chip, past-due ones go dim. They are stored engine-side in
`<userData>/plugins/crypto-research/state.json`, capped at 200, and removed with
the `×` in the UI.

> **The verb is off on every seat until you tick it**, under the seat's Intents
> list. Plugin verbs are always privileged — there is no way to ship one enabled
> by default. **The failure when it is not ticked is silent**: the line is not
> parsed as the verb, the handler never runs, and nothing is logged. To the
> agent it reads as an unrecognised intent. If the verb "does nothing", this is
> why, and it is the first thing to check.

`cryptowatch`, not `watch`, on purpose: verbs share one global namespace across
every installed plugin, and the second plugin to claim a name **does not load at
all**. `watch` is exactly the name two authors pick independently.

## Which folder it reads

In order:

1. **A folder you chose** — `Folder…` in the overlay, or the path field under
   `Manage Plugins… → Crypto Research → Settings`. If it does not exist you get
   an error naming the path. It does *not* quietly fall back to the session,
   because reading a different library than the one you named is worse than
   showing nothing.
2. **The active session's working directory**, walking up to three levels
   looking for a `research/` folder.

A session on a peer machine is refused by the host (`fsScope`) — there is no
local filesystem to read, and the viewer says that rather than showing empty.

Everything is re-read on each open. Nothing is cached, so a run that finishes
while the overlay is closed appears the next time you open it.

## What it carries

| On disk | Reached as |
|---|---|
| `skills/crypto-research/SKILL.md` | `/crypto-research:crypto-research <token> [deep]` |
| `agents/crypto-researcher.md` | `crypto-research:crypto-researcher` |
| `agents/crypto-assessor.md` | `crypto-research:crypto-assessor` |

The skill is the coordinator: it resolves the token's identity, spawns two
researchers (fundamentals, narrative — three on `deep`, with a peer-review
round), then hands the findings to the assessor, which writes the scored
`assessment.md`. The coordinator reads no research content itself, which is what
keeps a full run from filling the operator's session with prose.

**Content arrives at a seat's next start.** Ticking the plugin mid-session
grants the viewer immediately, but not the skill or the agents: bundle content
is written at spawn. Until that seat restarts, the skill name will not resolve.

### It spends money

This is a viewer **and** a research pipeline. The viewer is read-only and free —
the price header calls two public endpoints and nothing else. A research run
spawns two or three researcher subagents plus an assessor: real tokens, several
minutes. Nothing in the UI starts one; a run only ever begins because someone
invoked the skill.

## Installing

The directory name is the plugin id and they must match — keep it named
`crypto-research`.

Clodex → **Plugins ▸ Manage Plugins… ▸ Register Plugin…** → pick this folder.
That is the route to use: it records where the link points and gives the row an
Unregister button.

Then two per-seat steps, both off by default and both deliberate:

1. **Tick the plugin on the seat** (`⚙ session ▾ → 🔌 Plugins…`). A plugin
   reaches no seat until its own list includes it.
2. **Tick the `cryptowatch` verb** on that seat's Intents list, if you want
   agents to record watch items.

A renderer change needs an app restart (`require` caches by path); an engine
change needs only a Re-scan.

The renderer half is **desktop-only**. The browser bundle is built with the app
and inlines only the repo's own plugins, so a registered external plugin gets
its engine half on the web surface and no UI there.

### Capability checks

Both halves check the host APIs they need at activation and throw naming the
missing one. `hostApi` is `"1"` on every host that will run this and new APIs
arrive additively, so the manifest cannot express "needs a recent Clodex" — an
older host would otherwise fail with a `TypeError` from somewhere unhelpful and
be quarantined after two launches with nothing readable in the log.
`ui.pickDirectory` is checked at the point of use instead, so a host without it
loses one button rather than the viewer.

`scope` is deliberately absent (so: global). This plugin consumes none of the
three capability grants — it never reads turn text, thinking, or tool inputs.

## Shape

- `engine.js` — root resolution, the directory walk, header parsing, file
  reads, the watch list, and the verb. Every segment from the renderer or an
  agent is grammar-checked before it is joined to a path, and every read
  resolves symlinks at **each level** of the descent and prefix-checks the
  resolved string against the library root. A lexical `path.join` is defeated by
  a symlink inside the tree pointing out of it: the joined string stays under
  the root and the open does not.
- `renderer.js` — the overlay, the footer button, the settings section, the
  chart, and a markdown renderer that builds DOM nodes and sets every leaf
  through `textContent`. These documents are model-written prose; none of it
  becomes markup, and a link renders as text plus a bare URL rather than as an
  anchor.
- `market.js` — the only part that reaches the network. Plain Node `fetch`, no
  dependency, hard timeout, response cap, and single-flight per URL. Every
  failure returns a result rather than throwing, because an unreachable quote
  source is an expected condition here.
- `style.css` — all selectors `cr-`-prefixed, since plugin CSS is injected
  unscoped into every window, and every colour is a theme variable. Clodex ships
  light themes as well as dark ones.

### There is no sandbox

An engine half runs with the app's full privileges. The plugin API is a contract
for removability and versioning, not containment. That is true of every Clodex
plugin, including this one — install plugins you have read or trust.
