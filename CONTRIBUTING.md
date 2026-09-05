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
