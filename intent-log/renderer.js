'use strict';

// intent-log renderer — a live table of the intents granted seats emit.
//
// Every value shown comes from agent output, which is untrusted: it reaches the
// DOM through textContent only. There is no innerHTML on any path here.

module.exports.activate = (rhost) => {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };

  const hhmmss = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '--:--:--' : d.toTimeString().slice(0, 8);
  };

  let refs = null;
  let since = 0;        // highest line id painted
  let paused = false;
  let pending = false;  // an emit arrived while paused

  const filters = () => ({
    verb: refs && refs.verb.value ? refs.verb.value : null,
    session: refs && refs.session.value ? refs.session.value : null,
  });

  const keepPickers = (r) => {
    for (const [sel, values] of [[refs.verb, r.verbs], [refs.session, r.sessions]]) {
      const chosen = sel.value;
      if (sel.options.length - 1 === values.length
        && values.every((v, i) => sel.options[i + 1] && sel.options[i + 1].value === v)) continue;
      sel.replaceChildren(new Option(sel === refs.verb ? 'all verbs' : 'all agents', ''));
      for (const v of values) sel.appendChild(new Option(v, v));
      sel.value = values.includes(chosen) ? chosen : '';
    }
  };

  const rowFor = (line) => {
    const row = el('div', 'ilog-row');
    row.appendChild(el('span', 'ilog-at', hhmmss(line.at)));
    row.appendChild(el('span', 'ilog-agent', line.session));
    const verb = el('span', 'ilog-verb', line.sub ? `${line.verb} ${line.sub}` : line.verb);
    verb.dataset.verb = line.verb;
    row.appendChild(verb);
    row.appendChild(el('span', 'ilog-arg', line.arg || ''));
    return row;
  };

  const append = (lines) => {
    if (!lines.length) return;
    // Stick to the bottom only if the reader is already there — scrolling out
    // of a live feed to read something is a gesture, not an accident.
    const box = refs.rows;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const line of lines) frag.appendChild(rowFor(line));
    box.appendChild(frag);
    while (box.childElementCount > 500) box.removeChild(box.firstElementChild);
    if (atBottom) box.scrollTop = box.scrollHeight;
  };

  const empty = (msg) => refs.rows.replaceChildren(el('div', 'ilog-empty', msg));

  // Pull-on-open, and pull-on-event. Events are unbuffered: a window that was
  // closed during an emit hears nothing, so the pull is the contract and the
  // event only saves a timer.
  const pull = async (reset) => {
    if (!refs) return;
    if (reset) { since = 0; refs.rows.replaceChildren(); }
    const r = await rhost.invoke('recent', { since, ...filters() });
    if (!r || !r.ok) { empty(`Could not read the feed: ${(r && r.error) || 'no reply'}`); return; }
    keepPickers(r);
    if (!r.lines.length && since === 0) {
      empty('Nothing yet. A seat appears here once it holds this plugin AND has '
        + 'granted it the "turns" capability — both default to off.');
    } else {
      if (since === 0 && r.lines.length) refs.rows.replaceChildren();
      append(r.lines);
    }
    since = Math.max(since, ...r.lines.map((l) => l.id), 0);
    refs.count.textContent = since ? `${since} seen` : '';
  };

  const offEvent = rhost.events.on('changed', () => {
    if (!refs) return;
    if (paused) { pending = true; refs.pause.textContent = 'Resume •'; return; }
    pull(false);
  });

  const surface = rhost.ui.surfaces.overlay({
    id: 'main',

    mount(root) {
      root.replaceChildren();
      const wrap = el('div', 'ilog');

      const bar = el('div', 'ilog-bar');
      const verb = el('select', 'ilog-pick');
      const session = el('select', 'ilog-pick');
      verb.appendChild(new Option('all verbs', ''));
      session.appendChild(new Option('all agents', ''));
      const pause = el('button', 'ilog-btn', 'Pause');
      const clear = el('button', 'ilog-btn', 'Clear');
      const count = el('span', 'ilog-count', '');
      bar.append(verb, session, pause, clear, count);

      const head = el('div', 'ilog-head');
      head.append(el('span', 'ilog-at', 'time'), el('span', 'ilog-agent', 'agent'),
        el('span', 'ilog-verb', 'intent'), el('span', 'ilog-arg', 'argument'));

      const rows = el('div', 'ilog-rows');
      wrap.append(bar, head, rows);
      root.appendChild(wrap);
      refs = { verb, session, rows, pause, count };

      verb.addEventListener('change', () => pull(true));
      session.addEventListener('change', () => pull(true));

      pause.addEventListener('click', () => {
        paused = !paused;
        pause.textContent = paused ? 'Resume' : 'Pause';
        if (!paused && pending) { pending = false; pull(false); }
      });

      clear.addEventListener('click', async () => {
        const r = await rhost.invoke('clear');
        if (!r || !r.ok) { rhost.ui.showToast('Could not clear the feed.'); return; }
        pull(true);
      });
    },

    onOpen() { paused = false; pending = false; if (refs) refs.pause.textContent = 'Pause'; pull(true); },
  });

  rhost.ui.sidebar.footerButton({
    id: 'open',
    glyph: '⌁',
    label: 'Intents',
    tip: 'Live feed of the intents agents emit',
    onClick: () => surface.open(),
  });

  return () => {
    try { offEvent(); } catch { /* host releases it anyway */ }
    try { surface.dispose(); } catch { /* host may have removed it */ }
    refs = null;
  };
};
