---
description: Interview the operator and stand up a working Clodex team from one intent - create the team, let Clodex spawn and brief its lead, then report what the operator can now do. Usage - /team-bootstrap:team-bootstrap [project root] [what the project does]
---
# Stand up a team for this operator's project

You are the **contact agent**. The operator said something like *"I want a
project that does X and I need a team"*, and your job is to get from that
sentence to a team whose lead can dispatch its first ticket.

On Clodex ≥ 5.49.0 that is **one intent**. `[agent:team create]` with a body
mints the team, makes the hand per-ticket, saves the body as the project brief,
creates or adopts the root, spawns the lead in it on the stock lead template, and
tells that lead on its first turn which situation it is in. You interview, you
emit, you report. The lead talks to the operator from there.

So the shape of this skill is: **ask four things, emit one intent, read one line,
report it.** Nearly all of the configuration work older versions of this skill
told you to DM the lead is now done inside the host, in order, atomically.

Authority for everything here is `docs/teams.md` in the Clodex repo, section
*Checklist for a new project*. Where this file and a running Clodex disagree, the
host wins — read the bounce it gives you.

## Step 0 — can you do this at all?

`[agent:team create]` is a **privileged** intent: unlike ordinary verbs it is OFF
unless the operator explicitly ticked it, and an absent grant list does *not*
enable it. Check your own system prompt: if it holds no
`[agent:team create <name> root:…]` line, you do not have it.

If you do not have it, say exactly this much and **stop**:

> I can't create the team myself — the `team-create` intent is off for this seat.
> Enable it in this session's intent checklist (the ⚙ menu → intents → "Create
> teams (team create) — privileged, off by default"), then ask me again. Or use
> Teams ▸ Create Team… yourself and I'll brief the lead from there.

Do not interview first and discover this at the end. Nothing below works without
it, and an interview whose answers you then throw away has spent the operator's
attention for nothing.

**That is the only grant you need.** You do *not* need the `spawn` intent: a
create carrying a brief spawns the lead itself, from inside the host, and the
per-seat gate is checked before dispatch — so the internal spawn is not subject
to it by construction. (Below 5.49.0 the spawn is still yours; see *Older hosts*.)

## Step 1 — interview

One question per turn. **Ask only what you cannot infer**; defaults in brackets
are yours to apply silently if the operator has already implied them.

1. **Project root** — an absolute path, and which of two cases it is. This is the
   question with real consequences now, because create acts on the directory:

   - **A new project**: name a path whose **parent already exists**. Clodex
     `mkdir`s the leaf, `git init`s it and makes one empty commit. It creates the
     leaf only — never the path — so `/Users/me/code/new-thing` works when
     `/Users/me/code` is there, and a typo two levels up is refused rather than
     silently minting a tree.
   - **An existing project**: name a path that is **already a git repo with at
     least one commit**. Clodex writes nothing inside it — no init, no commit, no
     `.gitignore`, no README. The lead reads it and takes it over.
   - An **empty existing directory** counts as new.

   Two shapes are refused, and the operator has to fix them before you re-fire:
   a directory that has files but **no repo** (Clodex will not make a first commit
   of files it did not create — that would commit build output and secrets with no
   undo you can offer), and a **repo with no commits** (a worktree cannot be cut
   from a commitless repo, so the hand would refuse its first ticket). Say which
   one it is and the one command that fixes it; do not run it for them.

   Team name [basename of the root].

2. **Lead seat name** [`<team>-lead`]. Must not be a name that already exists,
   and must be 1–64 characters of `[a-zA-Z0-9._-]`. With a brief this is
   validated **before anything is written**, so a taken name costs you a bounce,
   not a half-built team.

3. **Model for the hands — an override question, not a specification.** Do *not*
   default to what you are running: you may be an expensive seat, and a hand that
   inherits your class costs the operator real money on every ticket. Ask:

   > The stock hand template sets the model and disables every skill (as of
   > Clodex 5.49.0: Opus, no skills). Want to override it?

   Take the answer as an **alias** — `opus`, `sonnet`, `haiku`, `fable`. **You do
   not apply this yourself**: `role-set` is lead-only, so an override becomes one
   short DM to the lead after it boots (step 3). If the operator has no
   preference, there is nothing to send and nothing to say beyond naming the
   default in your report.

   Name the version when you quote the default, exactly as above. You cannot read
   the stock template from here — it lives in Clodex, not in this plugin — so a
   bare "hands are Opus" goes stale silently the day it changes.

4. **The brief** — what the project is and what the operator wants built. This is
   the **body of the intent**, and it is the one thing the whole team reads: it is
   saved as `prompts/append/team-project.md`, which the stock lead and hand
   templates compose at boot. Get 5–15 lines. Build and test commands,
   conventions, what is generated, what breaks in non-obvious ways — plus, for a
   new project, what it should do.

   Write what the operator wants **built**, not what you expect Clodex to find:
   the brief is identical in both root cases, and the lead is told separately
   which one it is in.

**Do not ask about `scripts/run-tests.js`.** On a takeover the lead reads the repo
for it; on a new project there is nothing to read and the lead files the runner as
its first ticket. Asking the operator is asking them to do the lead's reading.

**Do not ask about the shape of the team.** Create gives you the standard shape —
lead, per-ticket hand, reviewer. Solo or a design role are edits the lead makes
afterwards, on request; mention that only if the operator raises it.

## Step 2 — the one intent you emit

The grammar is three parts: the intent line, the brief, and a bare `[agent:end]`
on its own line.

```
[agent:team create <team> root:<abs-root> lead:<lead-seat>]
<first line: one sentence of purpose>

<then paragraphs — the rest of the brief>
[agent:end]
```

(Fenced here because this file is documentation. **You emit it unfenced**, at
column 1, with the placeholders filled in — a fenced intent does not fire.)

Three things to get right:

- **The body is greedy.** It runs to the `[agent:end]` line or to the next
  column-1 intent, whichever comes first. Close it. An unclosed body swallows
  every remaining line of your reply — including the sentence you meant for the
  operator — into the brief, and that brief becomes a file every seat reads.
- **The first line is one sentence of purpose.** It is written verbatim, with no
  heading synthesized around it, and it is what a seat sees first.
- **The brief caps at 64KB**, the intent transport's limit. Over that, nothing is
  created.

Then **end your turn and read the reply.**

### The one line that comes back

```
[agent:team] team "shop" created — root /p/shop (new, git init'd), lead shop-lead,
dir ~/.clodex/teams/shop; hand takes a branch + worktree + seat per ticket; brief
saved to prompts/append/team-project.md; shop-lead spawned in the root on template
clodex-team-lead and briefed. Ask shop-lead for your first ticket.
```

Read the **root clause**: `(new, git init'd)` or `(existing repo, untouched)`.
That is how you know which scenario ran, and it belongs in your report.

Two variants are not failures but change what you say:

- **`… spawned in the root WITHOUT its template … — NOT briefed`.** The
  `clodex-team-lead` template is not installed on this host. The seat is up but
  the brief does not reach it, because it composes only through that template.
  Report that plainly and say it needs installing and the lead respawning.
- **`… could NOT be spawned (…) — the team is on disk; re-fire [agent:spawn …]`.**
  The team is fine. Emit exactly the spawn the reply hands you, if you hold the
  `spawn` grant; otherwise pass that command to the operator.

Anything starting `error:` created **nothing** — the message says so explicitly
and names what would have to change. Do not retry it unchanged, and do not report
a team that does not exist.

## Step 3 — the model handoff, and only if there is one

If the operator asked to override the hands' model in question 3, the lead has to
apply it: `role-set` is lead-only. Send one DM, and **fence the intent inside it**:

````
[agent:dm <lead-seat>]
Before your first ticket: the operator wants the hands on <alias>, not the stock
template's model. Emit this, unfenced, at column 1:

```
[agent:team role-set hand model:<alias>]
[agent:end]
```

Then carry on with your first turn as normal.
[agent:end]
````

The fence matters for the same reason the brief's `[agent:end]` does: a DM body
is greedy and ends at the next column-1 intent line, so an unfenced
`[agent:team role-set …]` inside it would **truncate your DM at that line** and
then **fire on you**, where every team verb is refused because you are not the
lead. Fenced lines are literal at every level of the scan. The outer
`[agent:dm …]` and its closing `[agent:end]` stay unfenced; only the inner intent
is quoted. Say in the DM that the lead unfences it when it emits it.

**If there is no override, send nothing.** The lead's own prompt holds its first
turn — reading the repo or filing the first ticket, then one `[agent:notify-user]`
to the operator. A briefing DM from you would duplicate it and cost a turn.

## What the lead does next, so you can set expectations

You are not driving this and should not describe it as work still to be done. On
its first turn the lead is told which arm it is in and follows its own prompt:

- **New project** — it reads the brief, decides the first ticket (usually the
  suite runner, since the merge gate runs `scripts/run-tests.js` and a repo
  without one cannot pass a ticket), and sends the operator one note confirming
  the plan plus at most three questions that actually block it.
- **Takeover** — it reads the README, the package manifest, the existing test
  runner and the CHANGELOG *first*, reconciles them against the brief, and asks
  only where the two disagree. "What does this project do" is never one of its
  questions, because the repo answered it.

Either way the operator gets one inbox note from the lead. Tell them to expect it.

## Older hosts

The plugin floor is Clodex 5.42.0, and the path above degrades in two steps.

**On 5.48.x** the brief works — the body is parsed, the hand is born per-ticket,
`team-project.md` is written — but create does **not** spawn the lead, does not
classify the root, and the root must already exist. The reply ends *"Next: spawn
the lead in that root — it composes the brief at boot."* So you need the ordinary
`spawn` grant, and you emit, **in a second reply after reading the create's**:

```
[agent:spawn name:<lead-seat> cwd:<abs-root>]
```

There is no first-turn opener on that host, so DM the lead one line naming the
team, the root and whether it is a new or existing project.

**On 5.47.0 and below the body is silently dropped.** The create parser is
anchored to end at the closing bracket, so the intent still fires — bodyless —
and your brief is left as ordinary prose in your turn. The result is a team with
a **standing** hand and **no** `team-project.md`, reported to you as a success.
Nothing bounces. That is the failure mode to recognise: if the reply ends
*"Next: spawn the lead in that root, then [agent:team gather]…"* and says nothing
about a brief, the body did not land.

There, use the old path: create bodyless, spawn the lead in a **separate reply**
after reading the create's reply, then DM the lead a briefing that writes
`prompt-save append team-project` and runs `role-set hand dispatch:worktree`
itself. `model:` does not exist below 5.46.0, so a hand needing a specific model
there needs a hand-written `template-save`, and a `model:` kv on such a host is
ignored rather than refused — a role whose template never changed is the symptom.

Check the host version before debugging any of this.

## The rules that bite

- **An intent must start its own line.** Prose before the bracket never fires.
  Leading whitespace does *not* protect a line — indentation is stripped before
  matching, so an indented intent still fires. Only a ``` fence or a `\[agent:`
  escape quotes one.
- **Bodies are greedy**, and this now applies to the create itself. The body ends
  at a bare `[agent:end]` or at the next column-1 intent line. Both of your
  possible emissions in this skill carry one.
- **A refused create wrote nothing.** Every refusal message ends *"no team was
  created"*, and it is true: validation runs before any write, and a brief that
  cannot be saved unwinds the manifest. The one thing not unwound is a failed
  lead spawn — the team is real and the reply hands you the retry.
- **`lead` and `reviewer` are operator-owned.** No intent may edit or remove
  them, so a different model for the *lead* is an app-side change, and a team the
  operator wants "lead only" still carries a reviewer definition. It renders as
  not addressable and nothing spawns for it. Say so rather than reporting a
  removal that did not happen.
- **`role-set`, not `role-add`, for `hand`.** Create writes `hand` already, and
  `role-add` on a role that exists with a different definition is **refused** —
  it is not an upsert. Relevant to the lead, and to you if you ever describe it.
- **`model:` derives a template; it does not edit one.** It reads the role's
  current template (or the stock `clodex-team-hand` when the role has none),
  swaps in `--model`, saves the result as `templates/<role>.json` and points the
  role there. So repeating it is safe — the re-derivation reads the role's own
  copy, and exactly one `--model` ever survives.
- **`model:` takes an alias or a bare id, never a bracketed one.** `opus`,
  `sonnet`, `haiku`, `fable`. `claude-opus-5[1m]` is unwritable as a kv: the
  parser stops at the first `]` and the truncated id is then refused outright, so
  it bounces rather than deriving a wrong template. That variant needs a
  hand-written template.

## If the operator asks about `[agent:team gather]`

Gather copies every library piece the team references into the team's own
directory. It is genuinely useful when the team must be self-contained — moved to
another machine, or removable without leaving pieces behind.

But `docs/teams.md` is explicit that **a gathered copy is a fork and stops
receiving upstream fixes**, and the stock role prompts ship as library files
precisely so every team keeps getting improvements to them. So do not suggest it
by reflex. The seam create already uses is the right one: stock prompts in the
library, everything project-specific in the team's own `team-project` brief. If
the operator does want it, `[agent:team gather dry]` shows the plan first, and it
is a lead-only verb — the lead runs it, not you.

## Worked example

Operator: *"I want a project that does invoice parsing and I need a team. Put it
in `/Users/me/code/invoices`."*

You establish that `/Users/me/code` exists and `invoices` does not (so: new
project), take `invoices` and `invoices-lead` as the names, hear no model
override, and take eight lines about what invoice parsing means here. Then one
reply:

```
[agent:team create invoices root:/Users/me/code/invoices lead:invoices-lead]
A CLI that parses supplier invoices into a normalised ledger row.

Input is PDF and CSV from about a dozen suppliers, each with its own layout.
Output is one JSON row per invoice, validated against schema/ledger.json.

Node, no framework. Tests run with node --test. Anything under out/ is
generated and never committed.
[agent:end]
```

The reply comes back naming the team, `(new, git init'd)`, and
`invoices-lead spawned in the root on template clodex-team-lead and briefed`. You
send nothing else, and you tell the operator:

> Team **invoices** is up at `/Users/me/code/invoices` — a new repo, created and
> git-init'd with one empty commit — led by `invoices-lead`, which is booting
> now. Its `hand` role takes a fresh branch, worktree and seat per ticket, so two
> tickets can never collide in one checkout; a `reviewer` role is defined and
> spawns on demand. Hands run on the stock template: Opus with every skill off,
> which is the cheap-by-default shape. What you told me is saved as the team's
> `team-project` brief, so every seat boots holding it. `invoices-lead` will
> message you shortly with its first ticket and anything it needs from you —
> there is no test runner yet, so filing one is almost certainly what it proposes
> first.

## What to report, and what not to

Report **what the operator can now do**, not a file listing. They did not ask for
`team.json`; they asked for a team. Name:

- the **team** and the **lead seat** they can talk to;
- the **root**, and **which scenario ran** — created and git-init'd, or an
  existing repo taken over untouched. This is the clause that tells an operator
  whether their files were touched, and it is the one thing only you can see;
- **per-ticket isolation** — that a hand ticket gets its own branch, tree and
  seat;
- the **model class** the hands run and that skills are off. A team is a standing
  cost, and an operator who does not know what class their hands are will find
  out from a bill;
- the **test caveat**, framed as the lead's next move rather than a gap: the
  merge gate needs `scripts/run-tests.js`, and the lead will either find one or
  file it;
- that **the lead will message them** — so they wait for it rather than asking
  you what happened.

If something was refused, say which thing and what the operator would have to do
themselves — `git init` in a directory that has files, a first commit in an empty
repo, a parent directory that does not exist, an app-side edit for
`lead`/`reviewer`. A refusal reported as a success is the worst outcome available
here, because the team looks configured and quietly is not.
