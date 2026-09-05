---
description: Review a change with focused reviewer subagents and consolidate one ranked report. Usage - /review-kit:review [base ref | "staged" | "head"] [quick]
---
# Peer code review of a change

You are the coordinator. You dispatch reviewers, then consolidate what they
return. You do **not** review the code yourself, and you read no source file
except to resolve a disagreement between two reviewers. Keep your context small
so the reviewers can be many.

## Setup

Args: an optional target (default `head`), and an optional `quick`.

Resolve the target to a diff:

- `staged` — `git diff --cached`
- `head` — `git diff HEAD~1..HEAD` (the most recent commit)
- anything else — treat it as a base ref: `git diff <ref>...HEAD`

Then collect, and keep for yourself only:

```
git diff --stat <range>          # the shape of the change
git diff --name-only <range>     # the file list
```

**If the diff is empty, stop and say so.** Do not review the working tree
instead — a review of something the user did not ask about is worse than no
review.

**If the diff exceeds ~2000 changed lines**, say so and ask whether to proceed,
split by directory, or narrow to a subset. Do not silently review a fraction.

Artifact dir `ART`: `<session scratchpad>/review/<short-sha-or-label>`. Create
it. Every reviewer writes one file there; nothing goes in the user's repo.

## Reviewers

Three lenses ship with this pack, namespaced by the plugin:

| Agent | Lens |
|---|---|
| `review-kit:correctness-reviewer` | Does it do what it claims? Logic, edge cases, error paths, concurrency. |
| `review-kit:interface-reviewer` | Contracts, naming, API shape, backward compatibility, docs that are now wrong. |
| `review-kit:test-reviewer` | What is untested, what a test asserts vs. what it claims, tests that cannot fail. |

If your available-agents list shows them under a different prefix (a seat may
also carry copies in its agent library), match on the agent name, not the
prefix.

**Full run:** all three, in parallel, in one message.
**`quick`:** `correctness-reviewer` only.

Spawn each with: the range, the file list, `ART`, its output path
(`$ART/<lens>.md`), and its lens. Let each run its own `git diff` — do not paste
the diff into the prompt, or three copies of it land in your context on the way
out.

## Consolidating

Read the three findings files. Produce one report, and apply these rules:

**Merge duplicates.** Two reviewers finding the same thing is one finding, at
the higher severity, noting that two lenses hit it — that is signal, not
repetition.

**Rank by severity, not by file order:**

- **Blocking** — a correctness bug, a data-loss path, a breaking change to a
  published contract, a security hole.
- **Should fix** — a real problem with a cheap fix, or a contract that is right
  in the code and wrong in the docs.
- **Consider** — a judgment call where the author may reasonably disagree.

**Nitpicks are dropped**, not demoted, unless the user asked for them. A report
where the reader has to sift is one they stop reading.

**Every finding cites `file:line` and says what to do.** A finding that only
names a smell is not actionable and does not go in.

**Drop findings the reviewer could not verify.** If a reviewer hedged ("this may
break if X"), either confirm X against the code yourself or leave it out. A
review that is 20% wrong makes the reader distrust the other 80%.

**If nothing is blocking, say that first, plainly.** The most useful review of a
good change is a short one that says it is good and names the two things worth a
second look.

Write the report to `$ART/review.md` **and** put it in your reply — the file is
for later, the reply is what the user reads now.

## What this pack does not do

It does not run the tests, lint, or the build. If those matter for the change,
run them yourself before dispatching and hand the reviewers the result — a
reviewer told "the suite is green" reviews differently from one guessing.
