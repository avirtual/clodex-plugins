'use strict';

module.exports.activate = (rhost) => {
  let disposed = false;
  let statusEl = null;

  const alive = () => !disposed;

  function field(bodyEl, key, label, hint, type) {
    const row = document.createElement('div');
    row.className = 'ntfy-settings-row';
    const lab = document.createElement('label');
    lab.className = 'ntfy-settings-label';
    lab.textContent = label;
    const input = document.createElement('input');
    input.type = type;
    input.className = 'ntfy-settings-input';
    input.setAttribute('data-ntfy-key', key);
    lab.appendChild(input);
    row.appendChild(lab);
    if (hint) {
      const h = document.createElement('div');
      h.className = 'ntfy-settings-hint';
      h.textContent = hint;
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
    if (res.lastEventAt) bits.push(`last message ${new Date(res.lastEventAt).toLocaleString()}`);
    if (res.lastId) bits.push(`resuming after id ${res.lastId}`);
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

      const url = field(bodyEl, 'url', 'Topic URL',
        'The full ntfy topic URL, e.g. https://ntfy.example.com/clodex. Empty means the plugin stays idle.', 'text');
      url.value = typeof v.url === 'string' ? v.url : '';

      const inbox = field(bodyEl, 'inbox', 'Inbox note',
        'Raise every message as an operator inbox note.', 'checkbox');
      inbox.checked = routes.inbox === undefined ? true : !!routes.inbox;

      const seat = field(bodyEl, 'seat', 'Also DM seat',
        'A session name to DM each message to, or empty for none. At most 10 messages every 10 minutes '
        + 'reach a seat, as a one-line summary; the inbox always gets the full text.', 'text');
      seat.value = typeof routes.seat === 'string' ? routes.seat : '';

      const allow = field(bodyEl, 'allowFrom', 'Only from',
        'Comma-separated tag or title prefixes, e.g. github. Empty means everything is accepted.', 'text');
      allow.value = asList(v.allowFrom);

      const ignore = field(bodyEl, 'ignoreTitles', 'Ignore titles containing',
        'Comma-separated, case-insensitive, e.g. labeled, unlabeled. Matching messages are dropped silently.', 'text');
      ignore.value = asList(v.ignoreTitles);

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
      const urlEl = get('url');
      const inboxEl = get('inbox');
      const seatEl = get('seat');
      const allowEl = get('allowFrom');
      const ignoreEl = get('ignoreTitles');
      // A missing field means the form is not the one rendered above, and a
      // patch built from defaults would then quietly overwrite real settings
      // with them. Save nothing instead.
      if (!urlEl || !inboxEl || !seatEl || !allowEl || !ignoreEl) return null;
      // The two lists are handed over as the raw strings they were typed as.
      // Splitting them here would put the parse in two places — the engine has
      // to do it anyway, since it must cope with values that never came through
      // this dialog — and two parsers for one format is how they drift.
      return {
        url: String(urlEl.value).trim(),
        routes: {
          inbox: !!inboxEl.checked,
          seat: String(seatEl.value).trim(),
        },
        allowFrom: String(allowEl.value).trim(),
        ignoreTitles: String(ignoreEl.value).trim(),
      };
    },
  });

  return () => {
    disposed = true;
    statusEl = null;
    try { if (typeof disposeSection === 'function') disposeSection(); } catch (_) {}
  };
};
