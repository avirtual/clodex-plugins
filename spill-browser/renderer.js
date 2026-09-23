'use strict';

// spill-browser renderer — a newest-first list of filed bodies over a reader.
//
// Every value shown is agent output, which is untrusted: list cells reach the
// DOM through textContent, and the body through rhost.lib.renderMarkdown, which
// never emits raw HTML. There is no innerHTML on any path here.

module.exports.activate = (rhost) => {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };

  const pad = (n) => String(n).padStart(2, '0');
  // Spills span days, so the date is part of the time.
  const when = (ms) => {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '--';
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const size = (b) => (b == null ? '' : b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} K`);

  let refs = null;
  let selected = null;   // "agent/id" of the row in the reader

  const keyOf = (r) => `${r.agent}/${r.id}`;

  const keepPickers = (r) => {
    for (const [sel, values, all] of [[refs.kind, r.kinds, 'all kinds'], [refs.agent, r.agents, 'all agents']]) {
      const chosen = sel.value;
      if (sel.options.length - 1 === values.length
        && values.every((v, i) => sel.options[i + 1] && sel.options[i + 1].value === v)) continue;
      sel.replaceChildren(new Option(all, ''));
      for (const v of values) sel.appendChild(new Option(v, v));
      sel.value = values.includes(chosen) ? chosen : '';
    }
  };

  const reader = (msg) => refs.doc.replaceChildren(el('div', 'spb-empty', msg));

  const open = async (r, row) => {
    selected = keyOf(r);
    for (const n of refs.rows.querySelectorAll('.spb-row.spb-on')) n.classList.remove('spb-on');
    row.classList.add('spb-on');

    refs.dochead.replaceChildren(
      el('span', 'spb-dh-verb', r.verb),
      el('span', 'spb-dh-agent', r.agent),
      el('span', 'spb-dh-at', new Date(r.ts).toLocaleString()),
      el('span', 'spb-dh-id', r.id),
    );
    if (r.ticket) refs.dochead.appendChild(el('span', 'spb-dh-src', `from ticket record ${r.ticket}`));
    if (r.head) refs.dochead.appendChild(el('div', 'spb-dh-head', r.head));

    const res = await rhost.invoke('read', { agent: r.agent, id: r.id });
    if (selected !== keyOf(r)) return;   // a later click won
    if (!res || !res.ok) { reader(`Could not read it: ${(res && res.error) || 'no reply'}`); return; }
    const body = el('div', 'spb-md');
    body.appendChild(rhost.lib.renderMarkdown(res.text));
    refs.doc.replaceChildren(body);
    refs.doc.scrollTop = 0;
  };

  const rowFor = (r) => {
    const row = el('div', 'spb-row');
    row.appendChild(el('span', 'spb-at', when(r.ts)));
    row.appendChild(el('span', 'spb-agent', r.agent));
    const verb = el('span', 'spb-verb', r.verb);
    verb.dataset.kind = r.kind;
    row.appendChild(verb);
    row.appendChild(el('span', 'spb-bytes', size(r.bytes)));
    // The file is gone and the body came from a ticket board instead.
    if (r.ticket) row.classList.add('spb-fromticket');
    const line = r.head || r.first || '';
    row.appendChild(el('span', 'spb-line', line));
    if (line) row.title = line;
    if (keyOf(r) === selected) row.classList.add('spb-on');
    row.addEventListener('click', () => open(r, row));
    return row;
  };

  // Pull-on-open, and pull-on-event. Events are unbuffered, so the pull is the
  // contract and the event only saves reopening the overlay.
  const pull = async () => {
    if (!refs) return;
    const res = await rhost.invoke('list', {
      kind: refs.kind.value || null,
      agent: refs.agent.value || null,
    });
    if (!res || !res.ok) {
      refs.rows.replaceChildren(el('div', 'spb-empty', `Could not list spills: ${(res && res.error) || 'no reply'}`));
      return;
    }
    keepPickers(res);
    if (!res.rows.length) {
      refs.rows.replaceChildren(el('div', 'spb-empty', 'No spills match.'));
    } else {
      const frag = document.createDocumentFragment();
      for (const r of res.rows) frag.appendChild(rowFor(r));
      refs.rows.replaceChildren(frag);
    }
    refs.count.textContent = res.total > res.rows.length
      ? `${res.rows.length} of ${res.total}` : `${res.total}`;
  };

  const offEvent = rhost.events.on('changed', () => { if (refs) pull(); });

  const surface = rhost.ui.surfaces.overlay({
    id: 'main',

    mount(root) {
      root.replaceChildren();
      const wrap = el('div', 'spb');

      const bar = el('div', 'spb-bar');
      bar.appendChild(el('span', 'spb-title', 'Spills'));
      const kind = el('select', 'spb-pick');
      const agent = el('select', 'spb-pick');
      kind.appendChild(new Option('all kinds', ''));
      agent.appendChild(new Option('all agents', ''));
      const count = el('span', 'spb-count', '');
      const close = el('button', 'spb-close', '×');
      close.title = 'Close';
      close.addEventListener('click', () => surface.close());
      bar.append(kind, agent, count, close);

      const head = el('div', 'spb-head');
      head.append(el('span', 'spb-at', 'time'), el('span', 'spb-agent', 'agent'),
        el('span', 'spb-verb', 'kind'), el('span', 'spb-bytes', 'size'),
        el('span', 'spb-line', 'head / first line'));

      const rows = el('div', 'spb-rows');
      const dochead = el('div', 'spb-dochead');
      const doc = el('div', 'spb-doc');
      wrap.append(bar, head, rows, dochead, doc);
      root.appendChild(wrap);
      refs = { kind, agent, rows, count, dochead, doc };
      reader('Pick a row to read it.');

      kind.addEventListener('change', pull);
      agent.addEventListener('change', pull);
    },

    onOpen() { pull(); },
  });

  rhost.ui.sidebar.footerButton({
    id: 'open',
    glyph: '⤓',
    label: 'Spills',
    tip: 'Browse the bodies Clodex filed out of transcripts',
    onClick: () => surface.open(),
  });

  return () => {
    try { offEvent(); } catch { /* host releases it anyway */ }
    try { surface.dispose(); } catch { /* host may have removed it */ }
    refs = null;
  };
};
