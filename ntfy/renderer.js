'use strict';

module.exports.activate = (rhost) => {
  let disposed = false;
  let statusEl = null;

  const alive = () => !disposed;

  // The row is a two-column grid — label, then field — and the label's text and
  // its input are therefore SIBLINGS rather than the input sitting inside the
  // label. `display: contents` on the label keeps both as direct grid items, so
  // the columns line up across every row while clicking the text still focuses
  // the field. Nesting the input inside the label and styling that instead is
  // what produced the ragged left edge: each row sized its own label.
  function field(bodyEl, key, label, hint, type) {
    const row = document.createElement('div');
    row.className = 'ntfy-settings-row';
    const lab = document.createElement('label');
    lab.className = 'ntfy-settings-label';
    const text = document.createElement('span');
    text.textContent = label;
    const input = document.createElement('input');
    input.type = type;
    input.className = 'ntfy-settings-input';
    input.setAttribute('data-ntfy-key', key);
    lab.appendChild(text);
    lab.appendChild(input);
    row.appendChild(lab);
    if (hint) {
      const h = document.createElement('div');
      h.className = 'ntfy-settings-hint';
      h.textContent = hint;
      // The hint is described BY the input rather than merely placed near it,
      // so a screen reader reaching the field reads the explanation with it
      // instead of stranding it as loose text between two controls.
      const hintId = `ntfy-hint-${key}`;
      h.id = hintId;
      input.setAttribute('aria-describedby', hintId);
      row.appendChild(h);
    }
    bodyEl.appendChild(row);
    return input;
  }

  // Settings hold whatever was last written, and `_host`'s settings.set can
  // write these keys as an array while this dialog writes a string. Both are
  // displayed the same way rather than one of them rendering as "[object
  // Object]" or as a value the operator did not type.
  function asList(v) {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join(', ');
    return typeof v === 'string' ? v : '';
  }

  /*
   * The topic table: one row per topic, each with its own seat.
   *
   * Rows are read back out of the DOM at save (see collect) rather than kept in
   * a parallel array here. One source of truth: an array would have to be kept
   * in step with the inputs on every keystroke, and the two drifting is how a
   * row the operator edited gets saved with its old value.
   */
  function renderTopics(bodyEl, v) {
    const wrap = document.createElement('div');
    wrap.className = 'ntfy-settings-row';
    const head = document.createElement('span');
    head.className = 'ntfy-settings-label';
    head.textContent = 'Topics';
    wrap.appendChild(head);

    const list = document.createElement('div');
    list.className = 'ntfy-topics';
    wrap.appendChild(list);

    const hint = document.createElement('div');
    hint.className = 'ntfy-settings-hint';
    hint.textContent = 'One row per topic on that server. The seat is optional — leave it empty '
      + 'for an inbox note only. Each seat has its own rate budget.';
    wrap.appendChild(hint);

    const addRow = (topic, seat) => {
      const row = document.createElement('div');
      row.className = 'ntfy-topic-row';
      row.setAttribute('data-ntfy-topic-row', '');

      const t = document.createElement('input');
      t.type = 'text';
      t.className = 'ntfy-settings-input';
      t.setAttribute('data-ntfy-row-key', 'topic');
      t.placeholder = 'topic';
      t.value = topic;

      const s = document.createElement('input');
      s.type = 'text';
      s.className = 'ntfy-settings-input';
      s.setAttribute('data-ntfy-row-key', 'seat');
      s.placeholder = 'seat (optional)';
      s.value = seat;

      const del = document.createElement('button');
      del.type = 'button';   // inside a dialog: a bare <button> would submit it
      del.className = 'ntfy-topic-del';
      del.textContent = '×';
      del.title = 'Remove this topic';
      del.addEventListener('click', () => row.remove());

      row.appendChild(t);
      row.appendChild(s);
      row.appendChild(del);
      list.appendChild(row);
      return row;
    };

    const rows = Array.isArray(v.topics) ? v.topics : [];
    for (const r of rows) {
      const row = (r && typeof r === 'object') ? r : {};
      addRow(String(row.topic == null ? '' : row.topic), String(row.seat == null ? '' : row.seat));
    }
    // An empty table gets one blank row rather than nothing at all: a bare Add
    // button with no fields under it reads as a feature that has not loaded.
    if (!rows.length) addRow('', '');

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ntfy-topic-add';
    add.textContent = '+ Add topic';
    add.addEventListener('click', () => { addRow('', '').querySelector('input').focus(); });
    wrap.appendChild(add);

    bodyEl.appendChild(wrap);
  }

  function renderStatus(res) {
    if (!statusEl) return;
    if (!res || !res.ok) {
      statusEl.textContent = 'Status unavailable.';
      return;
    }
    // `idle` outranks `connected`, and reads as itself rather than as "not
    // connected": an unset or unusable url is a thing the operator can fix in
    // the field directly above this line, and calling it "not connected" sends
    // them looking at the network instead.
    // Poll mode is reported as a state of its own rather than as plain
    // "connected": it IS working, so an error would be wrong, but it is
    // delivering late for a fixable reason and saying nothing would leave that
    // invisible — which is the whole failure this mode exists to escape.
    const live = res.mode === 'poll'
      ? 'polling (proxy buffering the stream — see the plugin log)'
      : (res.connected ? 'connected' : 'not connected');
    const bits = [res.idle ? res.idle : live];
    // The topics the ENGINE settled on, which is not always what the table
    // shows: a row it refused is absent here, and that difference is the only
    // on-screen tell that a topic is not actually subscribed.
    const topics = Array.isArray(res.topics) ? res.topics.map((t) => t.topic) : [];
    if (topics.length) bits.push(`${topics.length} topic${topics.length === 1 ? '' : 's'}: ${topics.join(', ')}`);
    if (res.lastEventAt) bits.push(`last message ${new Date(res.lastEventAt).toLocaleString()}`);
    if (res.error) bits.push(`error: ${res.error}`);
    statusEl.textContent = bits.join(' · ');
  }

  function refreshStatus() {
    rhost.invoke('status.get')
      .then((res) => { if (alive()) renderStatus(res); })
      .catch((e) => rhost.log.error('status.get failed', e));
  }

  const disposeSection = rhost.ui.settings.section({
    id: 'prefs',
    title: 'ntfy',
    render(bodyEl, values) {
      const v = values || {};
      const routes = (v.routes && typeof v.routes === 'object') ? v.routes : {};
      bodyEl.innerHTML = '';

      const server = field(bodyEl, 'server', 'Server',
        'The ntfy server, without a topic — e.g. https://ntfy.example.com. Empty means the plugin stays idle.', 'text');
      // `server` is empty on a 1.5.0 config, where the topic was part of the
      // url. The engine derives one in that case, and status.get reports what
      // it settled on — so showing that rather than an empty box means an
      // upgrading operator sees their real configuration, not a blank field
      // that looks like their settings were lost.
      server.value = typeof v.server === 'string' ? v.server : '';

      const inbox = field(bodyEl, 'inbox', 'Inbox note',
        'Raise every message as an operator inbox note.', 'checkbox');
      inbox.checked = routes.inbox === undefined ? true : !!routes.inbox;

      renderTopics(bodyEl, v);

      const allow = field(bodyEl, 'allowFrom', 'Only from',
        'Comma-separated tag or title prefixes, e.g. github. Empty means everything is accepted.', 'text');
      allow.value = asList(v.allowFrom);

      const ignore = field(bodyEl, 'ignoreTitles', 'Ignore titles containing',
        'Comma-separated, case-insensitive, e.g. labeled, unlabeled. Matching messages are dropped silently.', 'text');
      ignore.value = asList(v.ignoreTitles);

      const mute = field(bodyEl, 'muteAuthors', 'Mute comments by',
        'Comma-separated GitHub logins. Only their comments are dropped — opens, closes and '
        + 'labels still arrive. Set your own login here if an agent comments from your account.', 'text');
      mute.value = asList(v.muteAuthors);

      statusEl = document.createElement('div');
      statusEl.className = 'ntfy-settings-status';
      statusEl.textContent = 'Checking…';
      bodyEl.appendChild(statusEl);
      refreshStatus();
    },
    // RETURNS the patch and persists nothing itself. §6.6 is explicit that what
    // this returns is shallow-merged into the plugin's settings by the host, and
    // that returning null saves NOTHING — so the earlier shape here, which
    // invoked the engine's own `settings.set` and returned null, was asking the
    // host to save nothing while a second writer raced it. It also reported a
    // refusal into `statusEl`, which is inside a panel Save has already hidden.
    //
    // Nothing is validated here. A renderer cannot be the only door to a
    // setting — `_host`'s `settings.set` answers on both surfaces and can write
    // this key without going through this dialog — so the check that counts is
    // the one in the engine, at the point of use. Validating here as well would
    // give one rule two homes and let them drift.
    collect(bodyEl) {
      const get = (key) => bodyEl.querySelector(`[data-ntfy-key="${key}"]`);
      const serverEl = get('server');
      const inboxEl = get('inbox');
      const allowEl = get('allowFrom');
      const ignoreEl = get('ignoreTitles');
      const muteEl = get('muteAuthors');
      // A missing field means the form is not the one rendered above, and a
      // patch built from defaults would then quietly overwrite real settings
      // with them. Save nothing instead.
      if (!serverEl || !inboxEl || !allowEl || !ignoreEl || !muteEl) return null;
      // The two lists are handed over as the raw strings they were typed as.
      // Splitting them here would put the parse in two places — the engine has
      // to do it anyway, since it must cope with values that never came through
      // this dialog — and two parsers for one format is how they drift.
      // Rows with neither a topic nor a seat are dropped: an empty row is the
      // one left behind by Add and never filled in, and saving it would grow
      // the table by one blank line every time the dialog is opened.
      const topics = [...bodyEl.querySelectorAll('[data-ntfy-topic-row]')]
        .map((row) => ({
          topic: String(row.querySelector('[data-ntfy-row-key="topic"]').value).trim(),
          seat: String(row.querySelector('[data-ntfy-row-key="seat"]').value).trim(),
        }))
        .filter((r) => r.topic || r.seat);
      return {
        server: String(serverEl.value).trim(),
        topics,
        routes: { inbox: !!inboxEl.checked },
        allowFrom: String(allowEl.value).trim(),
        ignoreTitles: String(ignoreEl.value).trim(),
        muteAuthors: String(muteEl.value).trim(),
      };
    },
  });

  return () => {
    disposed = true;
    statusEl = null;
    try { if (typeof disposeSection === 'function') disposeSection(); } catch (_) {}
  };
};
