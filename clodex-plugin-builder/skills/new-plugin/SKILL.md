---
description: Build a Clodex plugin end to end - scaffold it, wire the surfaces it needs, and verify it against the real loader. Usage - /clodex-plugin-builder:new-plugin <id> [what it should do]
---
# Build a Clodex plugin

You are building a plugin for Clodex, the app you are running inside. This skill
carries the facts that are expensive to rediscover; the authority is the
contract, and where they disagree the contract wins.

## Step 0 — find the contract

The full contract ships **inside the app you are running**. Find it once:

```bash
ls "$(dirname "$(readlink -f /Applications/Clodex.app/Contents/MacOS/Clodex 2>/dev/null)")" 2>/dev/null
find ~/projects /Applications -maxdepth 4 -name plugin-api.md -path '*plugins*' 2>/dev/null | head -3
```

If you find a Clodex **checkout**, it also carries the author tools, and they
are the fastest path by a wide margin:

```bash
node plugins/tools/build-context.js /tmp/plugin-context.md   # the full pack
node plugins/tools/scaffold.js <id> <target-dir>             # a plugin that already passes
node plugins/tools/verify.js <dir>                           # run it against the REAL loader
```

**If `verify.js` exists, you must use it** — it loads the plugin through the
host's own loader, so it catches what reading cannot. If you find no checkout,
work from `plugin-api.md` alone and say in your final message that the plugin is
unverified.

Delegate the reading to `clodex-plugin-builder:api-scout` rather than pulling
the whole contract into your own context. Ask it for the specific sections your
plugin needs; it returns the rules and the signatures, not the prose.

## Step 1 — decide the shape

Ask, if the user has not said:

- **What should it DO** for the operator or for agents?
- **Where should it appear** — a sidebar button, a status-bar readout, a badge
  on session rows, a full overlay, a settings panel?
- **Does an agent need to reach it** — an `[agent:…]` verb?
- **Does it need code at all?**

That last one first, because it changes everything: a plugin that ships only
`skills/`, `agents/`, `prompts/` and `templates/` needs **no JavaScript**.
`"entry": {}` is legal when the directory carries a content bundle. If what the
user wants is a skill and some subagents, build that and stop — do not add an
engine to have one.

## Step 2 — the manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "hostApi": "1",
  "scope": "session",
  "entry": { "engine": "engine.js", "renderer": "renderer.js" },
  "style": "style.css",
  "enabledByDefault": false,
  "announce": "One sentence, shown in Manage Plugins."
}
```

Rules that refuse a manifest outright, so get them right first:

- **The folder name must equal `id`.** Lowercase, digits, hyphens.
- **`hostApi` is the string `"1"`.** Required — an absent one is refused, not
  defaulted.
- **`entry` must be an object**, even when empty.
- **`scope`, if present, is exactly `"global"` or `"session"`.** `"Session"` is
  a refusal. Add `scope: "session"` **only** if the plugin consumes a capability
  grant (today: the turn-text feed). It no longer controls visibility — a seat's
  plugin list does that.
- Entry and `style` paths must stay inside the plugin folder.

## Step 3 — write the halves

**Engine** (`engine.js`) is plain Node, no Electron, no DOM, full privileges.
**Renderer** (`renderer.js`) is browser context, no filesystem, no `window.api`.
They talk one way only: `rhost.invoke('method', …)` → `host.ipc.handle('method',
…)`, arguments structured-cloned, so plain data only.

```js
// engine.js
module.exports.activate = (host) => {
  host.ipc.handle('greet', (who) => ({ ok: true, text: `hello ${who}` }));
};
module.exports.deactivate = () => { /* release anything the host cannot */ };
```

Define `deactivate` at **module scope**, not by assigning to `module.exports`
inside `activate`.

Six rules that are not obvious and cost a debugging session each:

1. **Feature-check any recent API and throw**, naming the capability rather than
   a version: `hostApi` stays `"1"` and new APIs arrive additively, so the
   manifest cannot express "needs a newer Clodex". Throwing *is* the error
   channel; two failed launches quarantine the plugin until Retry.
2. **`style.css` is injected verbatim and unscoped into every window.** Prefix
   every selector with your own class or you will restyle the app.
3. **Never `innerHTML` anything an agent produced.** Build nodes and set
   `textContent`, or use `rhost.lib.renderMarkdown`, which never emits raw HTML.
4. **`host.events.emit(topic, payload, scope)` — `scope` is required**
   (`{session}`, `{workspace}`, or `'all'`), and an omitted one is a logged
   no-op, not a broadcast. `'all'` reaches every workspace, so it carries
   **invalidation hints only** — say the thing changed, let each window pull.
5. **Events are unbuffered**: a window closed during an emit hears nothing, so
   your surface must pull its own state on open. Events only save you a timer.
6. **`paths.dataDir` is not created for you.** `mkdir -p` it before writing your
   own files.

## Step 4 — surfaces

Seven slots: status-bar action, status-bar segment, sidebar footer button,
session row badge, session menu provider, settings panel, full overlay. You
supply data and callbacks; the host draws. Ask the scout for the exact spec of
the ones you use. Two behaviours that surprise people:

- **Row badges are painted synchronously** inside the sidebar's render loop.
  Return what is cached now and fill the cache in the background; the first
  paint is blank by design.
- **`mount(root)` on an overlay runs once, lazily, at first open.** One-time
  construction in `mount`, per-open refresh in `onOpen`.

## Step 5 — an intent verb, if it needs one

`host.intents.register(row)` adds an `[agent:verb]` any agent can emit. Three
properties: it fires **exactly once** per matched line (so a non-idempotent side
effect is safe), a **throw becomes a reply** to the emitting agent, and it is
**off for every seat until the operator ticks it** — there is no enabled-by-
default. That last one looks exactly like a broken registration, so say it in
the README.

Verbs are one flat global namespace across all installed plugins. The second
plugin to claim one is refused at activation. Pick `myplugin-run`, never `run`.

## Step 6 — verify, then hand over

Run `verify.js` if you found it. Fix everything it reports; it exercises the
real loader, including that `deactivate` releases what `activate` took.

Then write the plugin's `README.md` — required sections: what it does, the seat
it expects, what it writes and where. Plus, when they apply: that a verb is off
until ticked, and that a capability grant is off until granted.

Finally tell the user how to install it:

> **Plugins ▸ Manage Plugins… ▸ Register Plugin…**, pick the folder, then tick
> the plugin on the seat that should hold it. A renderer change needs an app
> restart (`require` caches by path); an engine change needs only a Re-scan.

## What a plugin cannot do

Do not design around these — they are refusals, not gaps: spawn a session,
change a session's command line, reach another plugin, register its own IPC
channel, touch the peer/remote wire, or read Clodex's own stores (`sessions.json`,
workspaces, teams, the library). It also cannot read another plugin's settings.

There is **no sandbox**: an engine half runs with the app's full privileges. The
API is a contract for removability and versioning, not containment. Say so
plainly if the user asks whether a plugin is safe to install.
