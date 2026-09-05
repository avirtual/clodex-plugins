'use strict';

// turn-log renderer — a footer button opening an overlay that browses and
// searches the logs the engine half writes.
//
// Everything shown here is agent text, which is untrusted input. It reaches the
// DOM through textContent only; there is no innerHTML on any path that touches
// a log row.

const MAX_ROWS = 200;

module.exports.activate = (rhost) => {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };

  const when = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleString();
  };

  const bytes = (n) => (n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

  let refs = null; // filled at mount

  const say = (msg) => {
    if (!refs) return;
    refs.rows.replaceChildren(el('div', 'tlog-empty', msg));
  };

  const paintRows = (rows, showSession) => {
    refs.rows.replaceChildren();
    if (!rows.length) { say('Nothing recorded yet.'); return; }
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const item = el('div', 'tlog-row');
      const head = el('div', 'tlog-row-head');
      head.appendChild(el('span', 'tlog-when', when(row.at)));
      if (showSession && row.session) {
        head.appendChild(el('span', 'tlog-session', row.session));
      }
      // isTurnEnd is null on transcript-sourced sessions — "not known", not
      // "no" — so only a literal true earns the marker.
      if (row.isTurnEnd === true) head.appendChild(el('span', 'tlog-flag', 'turn end'));
      if (row.truncated) head.appendChild(el('span', 'tlog-flag tlog-warn', 'truncated'));
      item.appendChild(head);
      item.appendChild(el('div', 'tlog-text', row.text));
      if (Array.isArray(row.files) && row.files.length) {
        item.appendChild(el('div', 'tlog-files', `wrote: ${row.files.join(', ')}`));
      }
      frag.appendChild(item);
    }
    refs.rows.appendChild(frag);
    refs.rows.scrollTop = refs.rows.scrollHeight;
  };

  const loadSessions = async (select) => {
    const r = await rhost.invoke('list');
    if (!r || !r.ok) { say(`Could not list logs: ${(r && r.error) || 'no reply'}`); return; }
    refs.picker.replaceChildren();
    if (!r.logs.length) {
      refs.picker.appendChild(new Option('no logs yet', ''));
      say('No sessions recorded yet. Grant a session the "turns" capability in its '
        + 'Intents popover, under Plugin Access, and its text lands here.');
      return;
    }
    for (const l of r.logs) {
      refs.picker.appendChild(new Option(`${l.session}  (${bytes(l.size)})`, l.session));
    }
    const wanted = select && r.logs.some((l) => l.session === select)
      ? select
      : r.logs[0].session;
    refs.picker.value = wanted;
    await loadRows(wanted);
  };

  const loadRows = async (session) => {
    if (!session) return;
    const r = await rhost.invoke('read', session, MAX_ROWS);
    if (!r || !r.ok) { say(`Could not read ${session}: ${(r && r.error) || 'no reply'}`); return; }
    paintRows(r.rows, false);
  };

  const runSearch = async (q) => {
    const r = await rhost.invoke('search', q);
    if (!r || !r.ok) { say((r && r.error) === 'empty query' ? 'Type something to search for.'
      : `Search failed: ${(r && r.error) || 'no reply'}`); return; }
    if (!r.hits.length) { say(`No matches for "${q}".`); return; }
    paintRows(r.hits, true);
    if (r.capped) refs.rows.appendChild(el('div', 'tlog-empty', 'Showing the first 200 matches.'));
  };

  const surface = rhost.ui.surfaces.overlay({
    id: 'main',

    mount(root) {
      root.replaceChildren();
      const wrap = el('div', 'tlog');

      const bar = el('div', 'tlog-bar');
      const picker = el('select', 'tlog-picker');
      const search = el('input', 'tlog-search');
      search.type = 'search';
      search.placeholder = 'Search all logs…';
      const reveal = el('button', 'tlog-btn', 'Reveal');
      const clear = el('button', 'tlog-btn tlog-danger', 'Clear');
      bar.append(picker, search, reveal, clear);

      const rows = el('div', 'tlog-rows');
      wrap.append(bar, rows);
      root.appendChild(wrap);
      refs = { picker, search, rows };

      picker.addEventListener('change', () => { search.value = ''; loadRows(picker.value); });

      let timer = null;
      search.addEventListener('input', () => {
        if (timer) rhost.clearTimeout(timer);
        timer = rhost.setTimeout(() => {
          const q = search.value.trim();
          if (q) runSearch(q); else loadRows(picker.value);
        }, 250);
      });

      reveal.addEventListener('click', async () => {
        const r = await rhost.invoke('dir');
        if (r && r.ok) rhost.ui.openPath(r.dir);
      });

      clear.addEventListener('click', async () => {
        const session = picker.value;
        if (!session) return;
        // eslint-disable-next-line no-alert
        if (!window.confirm(`Delete the recorded log for "${session}"? This cannot be undone.`)) return;
        const r = await rhost.invoke('clear', session);
        if (!r || !r.ok) {
          rhost.ui.showToast(`Could not clear: ${(r && r.error) || 'no reply'}`);
          return;
        }
        rhost.ui.showToast(`Cleared the log for ${session}.`);
        loadSessions();
      });
    },

    onOpen() {
      if (refs) refs.search.value = '';
      loadSessions(rhost.sessions.active());
    },
  });

  rhost.ui.sidebar.footerButton({
    id: 'open',
    glyph: '▤',
    label: 'Turn Log',
    tip: 'Browse and search recorded agent turns',
    onClick: () => surface.open(),
  });

  rhost.ui.settings.section({
    id: 'prefs',
    title: 'Turn Log',
    render(body, values) {
      body.replaceChildren();

      const note = el('div', 'tlog-note',
        'Records only sessions granted the "turns" capability, in the session\'s '
        + 'Intents popover under Plugin Access. Logs are plain text on disk.');
      body.appendChild(note);

      const field = (label, key, fallback) => {
        const row = el('label', 'tlog-field');
        row.appendChild(el('span', null, label));
        const input = el('input');
        input.type = 'number';
        input.min = '1';
        input.dataset.key = key;
        input.value = String(values[key] || fallback);
        row.appendChild(input);
        body.appendChild(row);
      };

      field('Rotate a session log past (MB)', 'maxFileMB', 5);
      field('Duplicate-suppression window (events)', 'dedupeWindow', 64);
    },
    collect(body) {
      const patch = {};
      for (const input of body.querySelectorAll('input[data-key]')) {
        const v = Number(input.value);
        if (!Number.isFinite(v) || v <= 0) continue;
        patch[input.dataset.key] = v;
      }
      // The engine reads bytes; the form asks for MB.
      if (patch.maxFileMB) {
        patch.maxFileBytes = Math.round(patch.maxFileMB * 1024 * 1024);
      }
      return patch;
    },
  });

  return () => { try { surface.dispose(); } catch { /* host may have removed it */ } refs = null; };
};
