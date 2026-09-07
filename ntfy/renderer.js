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
    const bits = [res.idle ? res.idle : (res.connected ? 'connected' : 'not connected')];
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
        'A session name to DM each message to, or empty for none.', 'text');
      seat.value = typeof routes.seat === 'string' ? routes.seat : '';

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
      // A missing field means the form is not the one rendered above, and a
      // patch built from defaults would then quietly overwrite real settings
      // with them. Save nothing instead.
      if (!urlEl || !inboxEl || !seatEl) return null;
      return {
        url: String(urlEl.value).trim(),
        routes: {
          inbox: !!inboxEl.checked,
          seat: String(seatEl.value).trim(),
        },
      };
    },
  });

  return () => {
    disposed = true;
    statusEl = null;
    try { if (typeof disposeSection === 'function') disposeSection(); } catch (_) {}
  };
};
