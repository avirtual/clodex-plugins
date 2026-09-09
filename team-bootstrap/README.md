# team-bootstrap

One skill that turns *"I want a project that does X and I need a team"* into a
working Clodex team. It is written for the seat the operator says that **to** — an
ordinary contact agent with no team of its own — and it drives the whole path:
interview, `[agent:team create]`, spawn the lead, then DM that lead the verbs only
a lead may run.

Content only — no engine, no renderer, no intent verb, and no code of any kind.
It adds nothing to Clodex; every verb it uses already ships there.

**Seat**: any seat the operator talks to, on any project. It is not
workspace-specific and does not need to be on a team — being *off* one is the
normal case, since the team it builds does not exist yet.

**Writes**: nothing itself. The intents it tells a seat to emit write
`~/.clodex/teams/<name>/` — `team.json`, and the prompts and templates the lead
saves there. **Your library at `~/.clodex/library/` is never touched**, by this
plugin or by any team verb. It holds no settings and no plugin storage.

## Prerequisites

- **Clodex ≥ 5.42.0**, for `[agent:team template-save]` and
  `[agent:team prompt-save]`. Without them a lead can create roles but cannot
  write the files those roles name. This is the floor for the plugin as a whole.
- **Clodex ≥ 5.46.0** for the shorter path, and the skill degrades cleanly below
  it rather than refusing:
  - `model:` on `role-add`/`role-set`, which derives a role's template instead of
    making the lead hand-write one. On an older host the kv is *silently ignored*,
    not refused, so the skill uses `template-save` there.
  - the lean stock hand template — `--model claude-opus-5`, every skill off,
    a trimmed tool list. Below 5.46.0 the shipped hand carries no model at all, so
    the interview has to ask for one outright.
  - the `clodex-run-tests` exec, a one-line suite digest for any project with
    `scripts/run-tests.js`. Below 5.46.0 the library def points at a script only
    the Clodex repo has; treat the grant as absent.
- **The `team-create` intent, ticked on the interviewing seat.** It is
  *privileged*: unlike ordinary verbs it is off unless the operator granted it
  explicitly, and an all-enabled seat does **not** get it by default. Session ⚙
  menu → intent checklist → *"Create teams (team create) — privileged, off by
  default"*. The skill checks for it first and stops with one sentence if it is
  missing, rather than interviewing and then failing.
- The ordinary **`spawn`** intent, to open the lead seat. Without it the skill can
  still create the team and tell the operator to open the seat themselves.

There is nothing to tick for the *lead* seat: the team verbs in the briefing are
gated on being the team's lead, not on a per-seat grant.

## What you get

`/team-bootstrap:team-bootstrap [project root] [what the project does]`

The skill's own content is mostly the three facts that make the difference between
a team that works and one that looks configured:

- **Every `[agent:team …]` verb except `create` is lead-only.** Resolved from the
  seat's cwd and refused for any seat that is not `team.lead`. So the skill splits
  the work: the contact agent creates and spawns, the lead configures.
- **`create` is not an empty team.** It writes `lead`, `hand` and `reviewer`
  already, all `standing`. So the verb that makes a hand take a branch per ticket
  is `role-set hand dispatch:worktree` — `role-add` on an existing role with a
  different definition is *refused*, not an upsert.
- **`lead` and `reviewer` are operator-owned.** No intent may edit or remove
  them, so a "lead only" team keeps a reviewer definition and a different model
  for the lead is an app-side change. The skill says so instead of retrying.
- **The interview does not choose models by inheritance.** It offers the stock
  hand template's default and asks only whether to override it — a contact agent
  running on an expensive seat must not hand that class to every role, since a
  team is a standing cost the operator pays per ticket.

It also carries the ordering that is not obvious: emit `create` **alone**, read
its reply, and spawn the lead only after it succeeded. Intents in one reply all
fire, so a create that bounces still leaves you a spawned seat — and a seat
resolves its team from its cwd at boot, so that one boots as a lead that does not
know it leads. Recoverable without a restart (team verbs re-resolve at emit time),
but it costs an explanation the operator did not need.

## What it deliberately does not do

- **It does not write `scripts/run-tests.js`.** With no TAP runner the merge gate
  escalates every ticket to the lead instead of rejecting it; the skill states
  that plainly as the trade-off it is. A project with no suite is a first-class
  case in Clodex, and inventing a harness for one is not this skill's call.
- **It does not run `[agent:team gather]` by reflex.** Gather forks the stock role
  prompts out of the library, and a fork stops receiving upstream fixes. The skill
  offers it for a team that must be self-contained and otherwise keeps the seam
  `docs/teams.md` recommends: stock prompts in the library, project specifics in
  the team's own `team-project` append prompt.
- **It writes no `team-project.md` content of its own.** That file is the one
  Clodex expects a human to author. If the operator has nothing to say yet, the
  skill writes a stub that names the gap rather than inventing conventions.

## Installing

Register this folder locally (**Plugins ▸ Manage Plugins… ▸ Register Plugin…**),
or install it by source spec:

```
avirtual/clodex-plugins:team-bootstrap                        # follows the default branch
avirtual/clodex-plugins@team-bootstrap-v0.1.2:team-bootstrap  # frozen, never updates
```

Then tick the plugin on the seat that should hold it. Content reaches only seats
whose plugin list holds the plugin, and it is bound when the seat starts — so a
running seat picks it up at its next start.

## License

Apache-2.0.
