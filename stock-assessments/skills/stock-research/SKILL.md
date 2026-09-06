---
description: Run ad-hoc peer-reviewed equity research on a stock ticker and produce a scored assessment. When run inside the stocks workspace (~/projects/stocks) assessments persist and gain prior-run continuity. Usage - /stock-research <ticker or company> [quick]
---
# Ad-hoc stock research run


You are the coordinator. You orchestrate; you never do the research yourself
and you read NO research content except the final `assessment.md`. Keep your
context tiny.

## Setup

Args: `<ticker or company name>` (required), optional `quick` (default: full).
If given a company name, resolve the ticker with one WebSearch.

**Artifact dir — two modes:**
- **Workspace mode:** if your cwd contains an `assessments/` directory (the
  dedicated stocks workspace), `ART` = `./assessments/<TICKER>/<YYYY-MM-DD>`.
  Also find the most recent PRIOR assessment: the newest earlier
  `./assessments/<TICKER>/*/assessment.md`, if any.
- **Scratch mode:** otherwise `ART` = `<session scratchpad>/stock-research/<TICKER>`
  and there is no prior.

## Spawning rules (all agents)

**Agent types.** The two researchers ship beside this skill in the
`stock-assessments` plugin, so they are namespaced: `stock-assessments:stock-researcher`
and `stock-assessments:stock-assessor`. If your available-agents list shows them
under a different namespace (a seat may also carry a copy from the agent
library), use whatever prefix that list gives — match on the agent name, not
the prefix, and do not invent one.

Agent tool, `run_in_background: false`, each agent named. Head-of-prompt
directives, one per line:

```
[wirescope:agent-name stock-<role>-<ticker>]
[wirescope:omit claudemd]
[wirescope:omit useremail]
```

Exception: in workspace mode, use `[wirescope:keep claudemd]` instead of the
omit — the workspace CLAUDE.md is research context, not project noise.

## Full tier

**Round 1** — spawn `stock-researcher` three times, ALL in ONE message
(roles: fundamentals, diligence, catalysts). Prompt per agent:

> Company: <name> (<TICKER>). ART=<$ART>. Tier: full. ROLE: <role>.
> [if prior exists] PRIOR: <path to previous assessment.md>
> Round 1: follow your round-1 instructions. Findings to <$ART>/<role>.p1.md.

**Round 2** — when all three replied `ok`, SendMessage EACH (one message):

> Round 2: peer p1 files are in <$ART>. Follow your round-2 instructions.
> Output: <$ART>/<role>.p2.md.

Collect the `done flags=...` replies.

**Assessment** — spawn `stock-assessor`:

> Company: <name> (<TICKER>). ART=<$ART>. Tier: full.
> [if prior exists] PRIOR: <path to previous assessment.md>
> Researcher flags: <flags verbatim, or "none">
> Follow your instructions. Assessment to <$ART>/assessment.md.

Pushback handling: if it replies `pushback <role> :: <question>`, relay to
that researcher, wait for `answered`, tell the assessor to finalize. At most
one round.

## Quick tier

Spawn `stock-researcher` once with ROLE: generalist (findings to
`<$ART>/generalist.p1.md`, PRIOR passed if it exists), then `stock-assessor`
with Tier: quick. No peer review, no pushback.

## Deliver

Keep your context tiny to the end. You have read no research content — do
NOT break that now. In particular, do NOT `Read` `$ART/assessment.md`: the
user sees it on their own screen (step 2), so reading it into your context
and then echoing it into your reply just duplicates the whole document twice
over. The assessor hands you a short headline; that headline is all you
relay.

1. Glob `$ART` to confirm `assessment.md` plus expected p-files exist.
2. Open the assessment on the operator's screen so they don't have to dig it
   up from disk — emit this intent at column 1 in your reply:

```
[agent:file open <$ART>/assessment.md]
```

3. Relay ONLY the assessor's final headline reply (score, conviction,
   one-line thesis, next dated catalyst) — a few lines, verbatim, not the
   document. In workspace mode give the saved path; in scratch mode note that
   nothing persists past the session. If (and only if) the user then asks for
   detail or a clarification, `Read` the file at that point and answer the
   specific question — don't pre-load it on spec.
4. Save a recall breadcrumb — emit this intent at column 1 in your reply:

```
[agent:memory remember] scope=stocks <TICKER> <YYYY-MM-DD>: score=<n> conviction=<c> — <one-line thesis>
```

The assessor updates `watchlist.md` itself in workspace mode — you don't
touch it.

This is research synthesis, not investment advice — the user owns all
financial decisions.
