---
description: Run lite crypto research on any token or protocol and write a scored, dated assessment into the workspace research library the Crypto viewer reads. Usage - /crypto-research:crypto-research <token or protocol> [deep]
---
# Lite crypto research

You are the **coordinator**. You orchestrate; you do no research yourself and
you read no research content except the final `assessment.md`. That is what
keeps a run from filling the operator's session with prose.

Upstream methodology: the `agentic-crypto` research desk. This is the lite
fork — no database, no prior-assessment continuity, no peer-score anchors. It
produces a first read, not a tracked position.

## Setup

Args: `<token or protocol>` (required), optional `deep` (default: lite).

1. **Resolve identity with ONE fetch** — a data lookup, not research:
   `https://api.coingecko.com/api/v3/search?query=<name>`
   Take the top `coins[]` entry's `id`, `symbol`, `name`.

   **The search id is the only id that works.** CoinGecko's `/coins/markets`
   silently omits ids it does not know rather than erroring, so a guessed id
   ("moonwell") returns a 200 with the token absent — indistinguishable from a
   token with no data. Never guess; always resolve. If the search returns
   nothing sensible, proceed with the user's name as given and say so in the
   spawn prompt, so the researchers know their market block will be empty.

2. **Find the library root.** In order:
   - a `research/` directory in the session's working directory, or up to
     three levels above it;
   - if none exists, create `research/` in the working directory and say so.

3. `ART` = `<library-root>/<SYMBOL>/<YYYY-MM-DD>` — create it. `SYMBOL` is
   uppercase, `[A-Z0-9][A-Z0-9.-]{0,15}`. Today's date, UTC.

   A second run on the same day writes into the same folder and overwrites its
   files. Assessments are point-in-time documents; a new day is a new folder.

## Spawning rules

Use the Agent tool with `run_in_background: false`, give each agent a `name`,
and put these directives at the head of every spawn prompt, one per line:

```
[wirescope:agent-name crypto-<role>-<symbol>]
[wirescope:omit claudemd]
[wirescope:omit useremail]
```

`omit claudemd` matters: this skill runs from arbitrary project sessions, and a
researcher must not inherit an unrelated project's instructions as if they were
research direction.

## Lite tier (default)

**One round, two researchers, no peer review.** Spawn
`crypto-research:crypto-researcher` twice, both in ONE message:

| name | ROLE |
|---|---|
| `crypto-fund-<symbol>` | `fundamentals` |
| `crypto-narr-<symbol>` | `narrative` |

Prompt per agent:

> Project: `<name>` (`<id>`, `<SYMBOL>`). ART=`<$ART>`. Tier: lite.
> ROLE: `<role>`. Follow your round-1 instructions. Findings to
> `<$ART>/<role>.p1.md`. Reply with your one-line flag summary only.

## Deep tier (`deep`)

**Round 1** — spawn the researcher three times in ONE message: `fundamentals`,
`narrative`, `diligence`. Same prompt shape as above with `Tier: deep`.

**Round 2** — when all three have replied, SendMessage EACH (one message):

> Round 2: the peer p1 files are in `<$ART>`. Follow your round-2 instructions.
> Output: `<$ART>/<role>.p2.md`.

## Assessment (both tiers)

Spawn `crypto-research:crypto-assessor`:

> Project: `<name>` (`<id>`, `<SYMBOL>`). ART=`<$ART>`. Tier: `<lite|deep>`.
> Researcher flags: `<flags verbatim, or "none">`
> Follow your instructions. Assessment to `<$ART>/assessment.md`.

If it replies `pushback <role> :: <question>` (deep tier only, at most once),
SendMessage that researcher with the question, wait for `answered`, then tell
the assessor the response is appended and to finalize.

## Deliver

1. Glob `$ART` to confirm `assessment.md` and the expected findings files exist.
2. Read `$ART/assessment.md` and relay the **verdict line and the thesis
   paragraph only** — not the whole document. It is on disk in the library, and
   the Crypto viewer renders it properly; pasting it here duplicates it into a
   context that will be summarized away.
3. Tell the operator the path, and that the run is visible in the Crypto
   overlay (sidebar `◈ Crypto`) on any seat holding this plugin.

## What this run is not

It has no database, no prior assessment to diff against, and no peer anchors —
so it cannot say "cheaper than it was in June" or "ranks 4th of the 41 tracked".
Say that once, plainly, rather than implying continuity the run does not have.
