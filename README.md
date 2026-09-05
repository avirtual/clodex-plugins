# clodex-plugins

Semi-official plugins for [Clodex](https://github.com/avirtual/clodex), the
visual multi-agent console. One plugin per top-level folder, each folder named
for the plugin's `id`.

## What a plugin is

A folder with a `manifest.json` and any of:

- `engine.js` — the main-process half (runs inside the app, full authority)
- `renderer.js` + `style.css` — the UI half (panels, buttons, drawers)
- `skills/`, `agents/`, `prompts/`, `templates/` — content bundles a seat
  can hold: skills the plugin's UI can invoke, subagents those skills fan out
  to, system/append prompts and seat templates

The contract is `plugins/plugin-api.md` in the Clodex repo (`hostApi "1"`).
`plugins/what-plugins-can-do.md` is the short version; `plugins/plugin-sources.md`
is where plugins come from and who is trusted to put them there.

## Installing one

Today: clone this repo, then in Clodex use **Plugins ▸ Manage Plugins… ▸
Register Plugin…** and pick the plugin's folder. It is linked into
`~/.clodex/plugins/<id>` without copying; a `git pull` here updates it.

Soon: **Install from GitHub…** in the same dialog, with a spec like
`avirtual/clodex-plugins:stock-assessments`. Installed plugins are pinned to a
commit, land disabled until you enable them, and never update on their own.

Then attach the plugin to the seat that should hold it (the seat's plugin
list in its session dialog). A plugin's panel only appears on a seat that
holds it.

## Trust

A plugin is in-process code with the same access as Clodex itself: your
shell, your files, your keys. Clodex cannot check it. Read what you install.
The plugins here are maintained by the Clodex author; anything else is yours
to judge.

## Plugins

| id | what it does |
|---|---|
| _(none yet)_ | |

`_template/` is a starting point for a new one — copy it, rename the folder to
your id, fill in the manifest.

## Layout rules

- Folder name == manifest `id` (lowercase, hyphens, 1–40 chars).
- Vendored `node_modules` beside the manifest is fine; nothing runs `npm
  install` on install, ever. No install scripts.
- `hostApi` is `"1"` and a string.
- Keep a `README.md` in the plugin folder: what it does, what seat it expects,
  what it writes and where.

## License

Apache-2.0, same as Clodex. Individual plugins may carry their own license
file; absent one, this applies.
