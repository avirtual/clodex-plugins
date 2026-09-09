# team-bootstrap

One skill that turns *"I want a project that does X and I need a team"* into a
working Clodex team. It is written for the seat the operator says that **to** — an
ordinary contact agent with no team of its own.

On Clodex ≥ 5.49.0 the whole path is **one intent**. `[agent:team create]` with a
brief mints the team, makes the hand per-ticket, saves the brief where every seat
reads it, creates or adopts the root, spawns the lead in it, and tells that lead
which situation it is in. The skill's job is the part Clodex cannot do: work out
what to put in that intent, and tell the operator what they now have.

Content only — no engine, no renderer, no intent verb, and no code of any kind.
It adds nothing to Clodex; every verb it uses already ships there.

**Seat**: any seat the operator talks to, on any project. It is not
workspace-specific and does not need to be on a team — being *off* one is the
normal case, since the team it builds does not exist yet.

**Writes**: nothing itself. The intent it tells a seat to emit writes
`~/.clodex/teams/<name>/` — `team.json` and `prompts/append/team-project.md` —
and, for a new project, creates and `git init`s the root. An existing repo given
as the root is **not touched**: no init, no commit, no `.gitignore`, no README.
**Your library at `~/.clodex/library/` is never touched**, by this plugin or by
any team verb. It holds no settings and no plugin storage.

## Prerequisites

- **The `team-create` intent, ticked on the interviewing seat.** It is
  *privileged*: unlike ordinary verbs it is off unless the operator granted it
  explicitly, and an all-enabled seat does **not** get it by default. Session ⚙
  menu → intent checklist → *"Create teams (team create) — privileged, off by
  default"*. The skill checks for it first and stops with one sentence if it is
  missing, rather than interviewing and then failing.
- **Clodex ≥ 5.49.0** for the one-intent path. Below it the skill degrades in two
  documented steps rather than refusing:
  - **5.48.x** — the brief lands (per-ticket hand, `team-project.md` written) but
    create neither spawns the lead nor classifies the root, and the root must
    already exist. The skill spawns the lead itself in a second reply, which needs
    the ordinary `spawn` grant.
  - **5.47.0 and below** — the create parser ends at the closing bracket, so a
    brief is **silently dropped** and the create succeeds bodyless: a standing
    hand and no project file, reported as a success. The skill names the reply
    text that tells you this happened, and falls back to the old path (bodyless
    create, separate spawn, then a DM briefing the lead runs itself).
  - **Below 5.46.0** the `model:` kv does not exist and is *ignored* rather than
    refused — a role whose template never changed is the symptom.
- **Clodex ≥ 5.42.0** is the floor for the plugin as a whole, for
  `[agent:team template-save]` and `[agent:team prompt-save]` — the verbs the
  fallback path depends on.

No `spawn` grant is needed on 5.49.0: create spawns the lead from inside the
host, below the per-seat gate. There is nothing to tick for the *lead* seat
either — the team verbs are gated on being the team's lead, not on a per-seat
grant.

## What you get

`/team-bootstrap:team-bootstrap [project root] [what the project does]`

Four questions, one intent, one report. The skill's own content is what is left
once the host does the configuration:

- **The root question, which now has consequences.** Create acts on the
  directory: a new project needs a path whose *parent* exists (Clodex makes the
  leaf and git-inits it), an existing project needs a repo with at least one
  commit (adopted, untouched). A directory with files but no repo, and a repo
  with no commits, are refused — and the skill explains which and hands the
  operator the one command, rather than running `git init` over files it did not
  create.
- **The interview does not choose models by inheritance.** It offers the stock
  hand template's default and asks only whether to override — a contact agent
  running on an expensive seat must not hand that class to every role, since a
  team is a standing cost the operator pays per ticket. An override becomes one
  short DM to the lead, because `role-set` is lead-only.
- **What it does *not* ask.** Not the test runner: on a takeover the lead reads
  the repo for it, on a new project there is nothing to read. Not the shape of
  the team: create gives you lead + per-ticket hand + reviewer, and anything else
  is an edit the lead makes later.
- **The greedy-body rules, in the two places they bite.** The brief is the
  intent's body and must be closed by a bare `[agent:end]`, or it swallows the
  rest of the reply into a file every seat reads. And an intent quoted inside a
  DM must be fenced, or the DM is truncated at that line *and* the intent fires
  on the sender, where every team verb is refused.
- **Reporting that names the scenario.** Which root case ran is visible only in
  the create's reply, and it is the clause that tells an operator whether their
  files were touched.

## What it deliberately does not do

- **It does not write `scripts/run-tests.js`,** and no longer asks about one.
  With no runner the merge gate escalates every ticket to the lead instead of
  rejecting it; the skill states that as the trade-off it is and leaves the
  runner to the lead, which either finds one in the repo or files it as the first
  ticket.
- **It does not brief the lead when there is nothing to add.** The lead's own
  prompt holds its first turn — read the repo or plan the first ticket, then one
  note to the operator. The skill sends a DM only to pass on a model override.
- **It does not run `[agent:team gather]` by reflex.** Gather forks the stock role
  prompts out of the library, and a fork stops receiving upstream fixes. The
  skill keeps the seam create already uses: stock prompts in the library, project
  specifics in the team's own `team-project` brief.
- **It writes no brief content of its own.** The brief is what the operator
  dictates. If they have nothing to say yet, the skill says so rather than
  inventing conventions a whole team will then read as fact.

## Installing

Register this folder locally (**Plugins ▸ Manage Plugins… ▸ Register Plugin…**),
or install it by source spec:

```
avirtual/clodex-plugins:team-bootstrap                        # follows the default branch
avirtual/clodex-plugins@team-bootstrap-v0.2.0:team-bootstrap  # frozen, never updates
```

Then tick the plugin on the seat that should hold it. Content reaches only seats
whose plugin list holds the plugin, and it is bound when the seat starts — so a
running seat picks it up at its next start.

## License

Apache-2.0.
