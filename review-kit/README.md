# review-kit

A code-review pack: one skill that fans a change out to three focused reviewer
subagents and consolidates their findings into a single ranked report. Content
only — no engine, no renderer, no intent verb, and no code of any kind.

**Seat**: any seat that works in a git repo. The skill runs `git diff` in the
seat's cwd, so it wants a seat rooted in the repo under review. Nothing about it
is workspace-specific.

**Writes**: only under the session scratchpad — `<scratchpad>/review/<label>/`,
one findings file per reviewer plus the consolidated `review.md`. It never
writes to your repo, and it holds no settings and no plugin storage.

## What you get

Holding this plugin gives a seat:

- `/review-kit:review [target] [quick]` — the coordinator skill.
- `review-kit:correctness-reviewer` — logic, edge cases, error paths, concurrency.
- `review-kit:interface-reviewer` — contracts, naming, compatibility, docs the
  change made wrong.
- `review-kit:test-reviewer` — what is untested, and tests that cannot fail.

Targets: `head` (default, the last commit), `staged`, or any base ref
(`main`, `origin/master`, a sha). `quick` runs correctness only.

The three reviewers can be delegated to directly, without the skill, if you want
one lens on something.

## Why three agents instead of one prompt

Each reviewer reads the diff itself rather than being handed it, so the coordinator
never accumulates three copies of the change. And a reviewer told to look at one
thing reports fewer, better findings than one told to look at everything — the
lenses have explicit "what NOT to report" sections for exactly that reason.

## What it does not do

It does not run tests, lint or builds. Run those yourself first and tell the
skill the result; a reviewer that knows the suite is green reviews differently
from one guessing. The test reviewer deliberately reads assertions rather than
running them.

## Installing

Register this folder locally (**Plugins ▸ Manage Plugins… ▸ Register Plugin…**),
or install it by source spec once your Clodex offers that:

```
avirtual/clodex-plugins:review-kit          # follows the default branch
avirtual/clodex-plugins@review-kit-v0.1.0:review-kit   # frozen, never updates
```

A plugin installed at a branch picks up later releases when you update it; one
installed at a tag is pinned to that commit and will never report an update.
Then tick the plugin on the seat that should hold it — content reaches only
seats whose plugin list holds the plugin, and it is bound when the seat starts,
so a running seat picks it up at its next start.

## License

Apache-2.0.
