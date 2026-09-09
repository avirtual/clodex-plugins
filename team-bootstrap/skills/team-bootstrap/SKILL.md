---
description: Interview the operator and stand up a working Clodex team from intents - create the manifest, spawn the lead, and brief that lead with the verbs only it can run. Usage - /team-bootstrap:team-bootstrap [project root] [what the project does]
---
# Stand up a team for this operator's project

You are the **contact agent**. The operator said something like *"I want a
project that does X and I need a team"*, and your job is to get from that
sentence to a team whose lead can dispatch its first ticket.

You are almost certainly **not on a team yourself**, and that is fine. Two of the
three steps below are yours; the middle of the work belongs to a seat that does
not exist yet.

**The one rule that shapes everything else: every `[agent:team …]` verb except
`create` is LEAD-ONLY.** Not "discouraged for others" — the handler resolves the
team from your cwd and refuses any seat that is not `team.lead`. So you create the
team, you spawn its lead, and then you **DM that lead a briefing** containing the
rest. You cannot run the rest yourself, and neither can the operator's other
seats.

Authority for everything here is `docs/teams.md` in the Clodex repo, sections
*Checklist for a new project* and *How a role finds its prompt*. Where this file
and a running Clodex disagree, the host wins — read the bounce it gives you.

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

You also need the ordinary **`spawn`** intent for step 2. If that one is missing,
you can still create the team and hand the operator a one-line instruction to
open the lead seat themselves.

## Step 1 — interview

One question per turn. **Ask only what you cannot infer**; defaults in brackets
are yours to apply silently if the operator has already implied them.

1. **Project root** — an absolute path that **already exists**. Clodex never
   creates it, and a root that another team already owns is refused. Team name
   [basename of the root].
2. **Lead seat name** [`<team>-lead`]. It must not be a name that already exists.
3. **Shape.** Propose one and say why in a line — see *Shapes* below. The operator
   can rename roles or add more.
4. **Model per role** [whatever you are running]. Free text you pass into the
   role's template as `extraArgs`. Current ids: `claude-opus-5`,
   `claude-sonnet-5`, `claude-fable-5-1`; a `[1m]` suffix asks for the 1M-context
   variant, e.g. `claude-fable-5-1[1m]`.
5. **Does the project have `scripts/run-tests.js` emitting TAP?** If not, say
   plainly: *the merge gate will escalate every ticket to the lead instead of
   rejecting it — the loop still works, it just is not autonomous.* **Do not
   create that file**, and do not offer to. A project with no suite is a
   first-class case, not a broken one.
6. **Project knowledge** — 5–10 lines the operator dictates: build and test
   commands, directories that are generated, conventions, what breaks in
   non-obvious ways. This becomes `prompts/append/team-project.md`, and it is the
   one file Clodex expects a human to write. If they have nothing to say yet, say
   you will write a stub naming the gap rather than inventing content.

### Shapes

`[agent:team create]` does **not** give you an empty team. It writes three roles
already: `lead` (standing), `hand` (standing, template `clodex-team-hand`) and
`reviewer` (standing). Every shape below is therefore an *edit* of that, which is
why the verb you need is usually `role-set` and not `role-add`.

| Shape | What it is | What the lead does to get there |
|---|---|---|
| **standard** | lead + worktree hand + reviewer. **The default for any code project.** | one `role-set hand dispatch:worktree` |
| **solo** | lead only, no implementer | `role-rm hand`. The `reviewer` role stays — see the note below. |
| **designed** | standard, plus a design role on a big-model standing seat | standard, plus one `role-add <name>` and its template |

`dispatch:worktree` is the whole point of the standard shape: it gives every
ticket for that role its own branch, its own git worktree and its own seat, which
is what stops two tickets colliding in one checkout. Without it a hand role can
only ever be one long-lived seat.

**On `solo`: an agent cannot remove the `reviewer` role.** It is operator-owned
topology and the mutator refuses an intent that touches it, so a "lead only" team
keeps a reviewer *definition*. That is harmless — the roster renders it as
`no live seat — role definition only, not addressable` and nothing spawns for it.
Tell the operator that rather than reporting a removal that did not happen.

## Step 2 — what you emit

Two intents — but **in two separate replies**, not one.

### First reply: the create, alone

```
[agent:team create <team> root:<abs-root> lead:<lead-seat>]
```

(Fenced here because this file is documentation. **You emit it unfenced**, at
column 1, with the placeholders filled in — a fenced intent does not fire.)

Then **end your turn and read the reply.** It comes back as an `[agent:team]`
line, and it is either

> `team "<team>" created — root …, lead …, dir …`

or a refusal: a missing grant, a root that is not a directory, a name already
taken. **Do not emit the spawn in the same reply as the create.** Intents in one
reply all fire — a create that bounces does not stop the spawn beside it, and you
get the teamless lead described below, plus a seat you now have to explain. This
is the single most likely way to get this wrong, and it has happened in practice.

### Second reply, only after the create succeeded: the spawn

```
[agent:spawn name:<lead-seat> cwd:<abs-root>]
```

**The order is load-bearing.** A seat's team is resolved from its cwd *at boot*,
and the roster it receives is delivered at spawn. Spawn the lead before the team
exists and it boots with no team block and no roster: it is a lead that does not
know it leads, or who else is on the team.

**It is recoverable, and you do not need a restart or a reload.** Every team verb
resolves the team from the seat's cwd *at emit time*, not from anything captured
at boot — so a lead spawned early can still run the entire briefing, and it works.
What such a seat misses is the *introduction*: the roster message is delivered at
spawn, so a seat that booted teamless does not receive one. If this happens, name
the team and the root in your briefing and carry on. Do not respawn the lead over
it, and do not tell the operator the team is broken — it is not.

Three things to get right in the spawn:

- **The name must equal `team.json`'s `lead` exactly.** Role matching is by name:
  the lead seat is recognised because its name *is* the lead pointer. A near miss
  spawns an ordinary seat in your project root.
- **`cwd:` is required** and should be the team root.
- **Pass no `template:`** unless the operator named a library one. A bare spawn
  gives the lead your own posture, which is the predictable choice; a team's own
  template cannot exist yet, because only the lead can write one.

Then confirm to the operator in one line that the team exists and the lead is
booting, and hand off.

## Step 3 — the briefing you DM the lead

Everything below runs **on the lead seat**, so send it as one DM. Fill in every
placeholder before you send; the lead cannot see your interview.

### ⚠ Fence the intents inside the DM, or the briefing breaks

A DM body is **greedy and ends at the next column-1 intent line**. So a briefing
that lists the lead's intents as bare lines does two wrong things at once, silently:

1. the DM is **truncated** at the first one — the lead receives one line of
   preamble and none of its instructions; and
2. those intent lines then **fire on you**, the contact agent, where every team
   verb is refused because you are not the lead.

**Put the intents the lead should emit inside a ``` fence.** Fenced lines are
literal at every level of the scan — no parse, no body boundary — so the whole
briefing arrives as one message. A `\[agent:` backslash escape works too; the
fence is easier to get right and reads better on the lead's screen.

The **outer** `[agent:dm …]` and its closing `[agent:end]` stay unfenced. Only the
inner intents are quoted.

````
[agent:dm <lead-seat>]
You are the lead of team <team>, root <abs-root>. Standing it up is your first
job. Emit these in order, each intent alone on its line, every body closed with a
bare [agent:end].

1. Write the project knowledge — this is the file Clodex expects a human to
   write, and the stem the shipped hand template already names:

```
[agent:team prompt-save append team-project]
<the 5-10 lines from interview question 6>
[agent:end]
```

2. For a standard shape:

```
[agent:team role-set hand dispatch:worktree] implementer; one ticket, one branch, one tree.
[agent:end]
```

   For a solo shape, instead:

```
[agent:team role-rm hand]
```

3. Per EXTRA role only — write its files FIRST, then add the role:

```
[agent:team template-save <stem>]
{"type":"claude","cwd":"${TEAM_ROOT}","extraArgs":["--model","<model-id>"],
 "execCommands":["clodex-team"],"appendPromptFiles":["team-project"]}
[agent:end]

[agent:team prompt-save system <stem>]
<the role prompt: how this role behaves, not what the project is>
[agent:end]

[agent:team role-add <role> template:<stem> prompt:<stem> dispatch:standing] <one-line brief>
[agent:end]
```

4. Read your roster back and check it. A team this new has **no exec defs at
   all**, so read the file with your own shell:

```
cat ~/.clodex/teams/<team>/team.json
```

   Then emit a bare

```
[agent:task list]
```

   to confirm the board resolves from your cwd — on a new team it answers
   "no tickets on <team>", and that answer *is* the confirmation. If the operator
   later grants you the clodex-team exec command, an exec of it with
   {"action":"roster","agent":"<lead-seat>"} renders the roster formatted.

Then DM me one paragraph: team name, root, your seat, each role with its
dispatch, and whether the merge gate has a suite to run
(scripts/run-tests.js emitting TAP — this project <does / does not> have one,
so tickets will <be verified / escalate to you>).
[agent:end]
````

The lead **unfences them when it emits them** — a fenced intent does not fire, on
its screen either. Say so in the briefing if the lead seems to be quoting them
back rather than running them.

### The rules that bite, and why each is in the briefing

- **An intent must start its own line.** Prose before the bracket never fires.
  Leading whitespace does *not* protect a line — indentation is stripped before
  matching, so an indented intent still fires. Only a fence or a `\[agent:`
  escape quotes one.
- **Bodies are greedy.** `prompt-save`, `template-save`, `role-add` and
  `role-set` all swallow everything after them until a bare `[agent:end]` line or
  **the next column-1 intent line**. An unclosed body eats the rest of the reply,
  including the sentence meant for the operator — and a body that runs into
  another intent is cut there, which is the failure the fence above prevents.
- **`role-set`, not `role-add`, for `hand`.** `hand` already exists after
  `create`, and `role-add` on an existing role with a different definition is
  **refused** — it is not an upsert. This is the single most likely way to get a
  team that looks configured and still dispatches to a standing seat.
- **`role-set` refuses `lead` and `reviewer` outright.** Both are operator-owned
  topology. A reviewer template, or a different model for the lead, is a change
  the operator makes in the app — say so rather than retrying.
- **`cwd:` is relative to the team root, and the directory must already exist.**
  An absolute path is refused because it could point a seat at another project,
  and a relative path that is not there yet is refused too. Create the directory
  before naming it, or omit `cwd` entirely.
- **Write a template or prompt before the role that names it.** Nothing enforces
  this — a role may name a stem that does not exist and the write succeeds — but
  team preflight will flag the role as **missing** until the file lands, and a
  seat spawned in that window boots with no system prompt at all. (Deleting runs
  the other way: `template-rm` and `prompt-rm system` are refused while a role
  still names the stem.)
- **Bodies cap at 64KB**, which is the intent transport's limit, not the file's.

### `[agent:team gather]` — optional, and it has a cost

Gather copies every library piece the team references into the team's own
directory. It is genuinely useful when the team must be self-contained — moved to
another machine, or removable without leaving pieces behind.

But `docs/teams.md` is explicit that **a gathered copy is a fork and stops
receiving upstream fixes**, and the three stock role prompts ship as library files
precisely so every team keeps getting improvements to them. So do **not** gather
by reflex. The recommended seam is the one step 1 of the briefing already uses:
leave the stock prompts in the library, and put everything project-specific in
`prompts/append/team-project.md`.

If the operator does want it, `[agent:team gather dry]` shows the plan first, and
it never overwrites what the team already owns.

## Worked example — a two-role team

Operator: *"I want a project that does invoice parsing and I need a team. Root is
`/Users/me/code/invoices`."*

You ask three questions (name → `invoices`; lead → `invoices-lead`; shape →
standard, because it is a code project with commits to isolate), learn there is no
`scripts/run-tests.js`, and take six lines of project knowledge. Then you emit
one intent and end your turn:

```
[agent:team create invoices root:/Users/me/code/invoices lead:invoices-lead]
```

The reply says the team was created. **Only then**, in your next reply:

```
[agent:spawn name:invoices-lead cwd:/Users/me/code/invoices]
```

and you DM `invoices-lead` a briefing whose whole configuration step is two intents —
the append prompt, and `role-set hand dispatch:worktree` — because `create`
already wrote the hand and the reviewer. The lead reads its roster back, DMs you,
and you tell the operator:

> Team **invoices** is up at `/Users/me/code/invoices`, led by `invoices-lead`.
> Its `hand` role takes a fresh branch, worktree and seat per ticket; a `reviewer`
> role is defined and spawns on demand. Your project notes are in the team's own
> `team-project` append prompt, so every ticket seat boots holding them. There is
> no `scripts/run-tests.js`, so the merge gate can't verify a branch itself —
> every ticket will escalate to the lead for a judgement call, which works but
> isn't autonomous. Ask `invoices-lead` for the first ticket whenever you like.

## What to report, and what not to

Report **what the operator can now do**, not a file listing. They did not ask for
`team.json`; they asked for a team. Name the team, the root, the lead seat they
can talk to, each role and whether a ticket for it gets its own branch, and the
one honest caveat about tests.

If something was refused, say which thing and what the operator would have to do
themselves — an app-side edit for `lead`/`reviewer`, a directory that has to exist
before a `cwd` can name it. A refusal reported as a success is the worst outcome
available here, because the team looks configured and quietly is not.
