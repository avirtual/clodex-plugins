# Contributing a plugin

1. Copy `_template/` to `<id>/` where `<id>` is your manifest id.
2. Fill in `manifest.json`. `id`, `hostApi` and at least one `entry` (or a
   content bundle folder) are required; see `plugins/plugin-api.md` §2 in the
   Clodex repo for every field and why a manifest gets refused.
3. Develop against a local checkout: **Manage Plugins ▸ Register Plugin…**
   on your folder, then **Re-scan** after edits to the engine half (the UI
   half needs an app restart — `require` caches by path).
4. Write the plugin's `README.md`: purpose, the seat it expects, what it
   writes on disk.
5. No network fetches at load, no `npm install`, no background processes
   left running past a call. A plugin that throws in `activate()` is skipped
   and held back after two failed launches, so fail loudly rather than
   half-loading.
6. Open a PR. A plugin here is one the Clodex author has read.

## Versioning a plugin

Plugins version themselves; the app's version is not theirs.

- **`version` in the manifest is a release number.** SemVer-shaped, bumped on
  every release you cut. Keep it plain digits and dots: a suffix like
  `1.0.0-beta` is not comparable to the host, and an uncomparable version can
  never supersede another copy of the same id. Tag a pre-release in git if you
  want one; the manifest stays numeric.
- **Tag releases `<id>-v<x.y.z>`** — one repo holds many plugins, so the id has
  to be in the tag.
- **Updates are resolved by commit, not by `version`.** An update re-resolves the
  ref the plugin was installed from and compares commits, so bumping `version`
  is not what makes an update appear — pushing is. Bump it anyway: it is what a
  human reads, and it decides which copy wins when two roots hold the same id.
- **A push touching one plugin does not make the others report an update**, even
  though they share a repo and therefore a commit. An update counts only when the
  commit differs *and* the fetched subfolder differs byte-for-byte from the
  installed one, so a plugin whose folder nobody touched resolves to "up to
  date". Worth knowing when you are reasoning about it: the commit alone would be
  the wrong test in a monorepo, and it is not the test used.

## Depending on a host capability

`hostApi` is `"1"` and stays `"1"` — new host APIs arrive additively, so the
manifest **cannot** express "needs a recent Clodex". A plugin that calls a newer
API on an older host gets `undefined` and a `TypeError`, and after two failed
launches it is held back with nothing readable explaining why.

So check the capability yourself, first thing in `activate()`, and throw:

```js
module.exports.activate = (host) => {
  if (typeof host.sessions.onAgentText !== 'function') {
    throw new Error('this host has no host.sessions.onAgentText; a newer Clodex is needed');
  }
  …
};
```

**Name the capability, not a version number.** "no `host.sessions.onAgentText`"
stays true forever; "needs Clodex ≥ 5.31" goes stale the first time something is
backported, and nobody re-verifies it. Throwing is the documented error channel —
the message is what the operator reads in the log.

## Required README sections

Every plugin's `README.md` says: what it does, the seat it expects, and what it
writes on disk. Two more when they apply:

- **If it registers an `[agent:…]` verb**, say that the verb is off for every
  seat until the operator ticks it in that session's intent checklist. A freshly
  installed plugin's verb is inert everywhere, silently, and looks exactly like a
  broken registration. Every user hits this once.
- **If it needs a per-session grant** — `turns` for the agent-text feed, and the
  `scope: "session"` manifest field that feed also requires — say which, and that
  the plugin receives nothing at all until it is granted.
- **If it costs the operator money**, say so under its own heading. A plugin that
  can spawn subagents or start a long run is spending real tokens, and a stranger
  who installed it for one feature should not discover the other by clicking it.

## Reaching a network service

The contract's advice is to shell out to a CLI the operator has already
authenticated (`gh`, `kubectl`), because then the CLI holds the token and the
plugin holds none. **That reasoning is about credentials.** For a keyless public
endpoint there is no credential to misplace, so a direct `fetch` from the engine
half is fine and does not need a CLI wrapped around it to launder it.

What such a plugin owes its user instead:

- **A hard timeout and a response size cap.** An engine half runs in the app's
  process; a hung or unbounded read is the app's problem, not just yours.
- **A User-Agent that identifies the plugin, not the operator.** If a service
  wants a contact address, take it from a setting the operator typed themselves
  and leave it blank until they do. Never send an identity they did not enter.
- **Degrade to the last good value, or to nothing.** Undocumented endpoints break
  without notice. Decide now what the surface shows when it does, and say so in
  the README — "when this breaks, this is what you see" is the difference between
  a known limit and a bug report.
- **Say in the README that it makes the call, and to where.** Someone installing
  a viewer is entitled to know it talks to the network.

`stock-assessments` is the worked example of all four.

## `enabledByDefault`

Ship `false` unless the plugin is inert until deliberately used. It is a shared
collection: a plugin that switches itself on across every seat of a repo the
operator registered for one other plugin has made a choice that was theirs. Both
`true` cases are narrow — a plugin with no side effects and no cost, or one the
operator installed for exactly that purpose.
