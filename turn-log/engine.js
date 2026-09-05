'use strict';

// turn-log — appends what agents say to a per-session JSONL file.
//
// The feed (host.sessions.onAgentText) is at-least-once and fires per REQUEST,
// not per turn. Both facts shape this file: every append is deduplicated on a
// content hash, and nothing here assumes one event per turn.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The host's shared session-name rule. Session names reach us as filenames, so
// they are re-checked here rather than trusted: no slashes can appear, but a
// name that fails this is a name we do not understand and will not write for.
const SESSION_NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;

const DEFAULTS = {
  maxFileBytes: 5 * 1024 * 1024, // per session, before the log rotates once
  dedupeWindow: 64,              // recent hashes remembered per session
};

// Module scope, so the export exists before activate() ever runs.
let teardown = null;

module.exports.activate = (host) => {
  // Capability check first. `hostApi` is "1" and stays "1" — new host APIs
  // arrive additively — so the manifest cannot express "needs a recent
  // Clodex" and this is the only place the requirement can live. Name the
  // capability, not a version: this sentence stays true forever.
  if (!host.sessions || typeof host.sessions.onAgentText !== 'function') {
    throw new Error(
      'this host has no host.sessions.onAgentText; a newer Clodex is needed to record turns'
    );
  }

  const logsDir = path.join(host.paths.dataDir, 'logs');

  // dataDir is not created for us, and storage.set() is not what makes these
  // files — so we make it ourselves, once, lazily.
  let dirReady = false;
  const ensureDir = () => {
    if (dirReady) return true;
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      dirReady = true;
    } catch (e) {
      host.log.error(`could not create ${logsDir} — ${(e && e.message) || e}`);
    }
    return dirReady;
  };

  const config = () => {
    const s = host.settings.get() || {};
    const n = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
    return {
      maxFileBytes: n(s.maxFileBytes, DEFAULTS.maxFileBytes),
      dedupeWindow: n(s.dedupeWindow, DEFAULTS.dedupeWindow),
    };
  };

  const fileFor = (session) => path.join(logsDir, `${session}.jsonl`);

  // ── Deduplication ────────────────────────────────────────────────────────
  // Delivery is at-least-once: when the wire's observer fails for a request,
  // Clodex replays that turn's tail from the transcript and text the wire
  // already delivered arrives a second time. Appending is not idempotent, so
  // the guard is ours to write. Keyed on content, because raw text has no id.
  const recent = new Map(); // session -> { seen:Set, order:[] }

  const isDuplicate = (session, hash, window) => {
    let r = recent.get(session);
    if (!r) { r = { seen: new Set(), order: [] }; recent.set(session, r); }
    if (r.seen.has(hash)) return true;
    r.seen.add(hash);
    r.order.push(hash);
    while (r.order.length > window) r.seen.delete(r.order.shift());
    return false;
  };

  // A single rotation, not a rolling series: the point is a bound on disk, and
  // one previous file is enough to survive a rotation mid-investigation.
  const rotateIfLarge = (file, maxBytes) => {
    try {
      if (fs.statSync(file).size < maxBytes) return;
      fs.renameSync(file, `${file}.1`);
    } catch { /* absent, or a rename we cannot do — either way, keep appending */ }
  };

  const off = host.sessions.onAgentText((ev) => {
    // Synchronous by contract — returning a promise is a violation, so every
    // write here is sync. A throw is contained per subscriber, but a throw per
    // request is noise in the log, so failures are caught and counted instead.
    try {
      const session = ev && ev.session;
      const text = ev && ev.text;
      if (!session || !SESSION_NAME_RE.test(session)) return;
      if (typeof text !== 'string' || !text) return;

      const { maxFileBytes, dedupeWindow } = config();
      const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
      if (isDuplicate(session, hash, dedupeWindow)) return;
      if (!ensureDir()) return;

      const file = fileFor(session);
      rotateIfLarge(file, maxFileBytes);

      // isTurnEnd is null on the jsonl path — the transcript has no protocol
      // turn-end signal — so it is stored as given rather than coerced to
      // false. null means "not known", and a reader must not read it as "no".
      const row = {
        at: new Date().toISOString(),
        session,
        source: ev.source || null,
        isTurnEnd: typeof ev.isTurnEnd === 'boolean' ? ev.isTurnEnd : null,
        truncated: !!ev.truncated,
        files: Array.isArray(ev.files) ? ev.files.map((f) => f && f.path).filter(Boolean) : [],
        hash,
        text,
      };
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
    } catch (e) {
      host.log.error(`append failed — ${(e && e.message) || e}`);
    }
  });

  // ── Reading, for the renderer half ───────────────────────────────────────

  const readRows = (session, limit) => {
    const rows = [];
    let raw;
    try {
      raw = fs.readFileSync(fileFor(session), 'utf8');
    } catch { return rows; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch { /* a torn final line */ }
    }
    return typeof limit === 'number' ? rows.slice(-limit) : rows;
  };

  const listLogs = () => {
    if (!fs.existsSync(logsDir)) return [];
    let names;
    try { names = fs.readdirSync(logsDir); } catch { return []; }
    return names
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => {
        const session = n.slice(0, -'.jsonl'.length);
        let size = 0; let mtime = 0;
        try {
          const st = fs.statSync(path.join(logsDir, n));
          size = st.size; mtime = st.mtimeMs;
        } catch { /* raced a rotation */ }
        return { session, size, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  };

  const disposers = [
    off,
    host.ipc.handle('list', () => ({ ok: true, logs: listLogs(), dir: logsDir })),

    host.ipc.handle('read', (session, limit) => {
      if (typeof session !== 'string' || !SESSION_NAME_RE.test(session)) {
        return { ok: false, error: 'not a session name' };
      }
      const n = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 200;
      return { ok: true, session, rows: readRows(session, n) };
    }),

    host.ipc.handle('search', (query, opts) => {
      const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
      if (!q) return { ok: false, error: 'empty query' };
      const only = opts && typeof opts.session === 'string' ? opts.session : null;
      const hits = [];
      for (const { session } of listLogs()) {
        if (only && session !== only) continue;
        for (const row of readRows(session)) {
          if (typeof row.text !== 'string') continue;
          if (!row.text.toLowerCase().includes(q)) continue;
          hits.push({ session, at: row.at, text: row.text });
          if (hits.length >= 200) return { ok: true, hits, capped: true };
        }
      }
      return { ok: true, hits, capped: false };
    }),

    host.ipc.handle('clear', (session) => {
      if (typeof session !== 'string' || !SESSION_NAME_RE.test(session)) {
        return { ok: false, error: 'not a session name' };
      }
      const file = fileFor(session);
      try {
        fs.rmSync(file, { force: true });
        fs.rmSync(`${file}.1`, { force: true });
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
      recent.delete(session);
      return { ok: true };
    }),

    host.ipc.handle('dir', () => ({ ok: true, dir: logsDir })),
  ];

  teardown = () => {
    for (const d of disposers) { try { d(); } catch { /* already gone */ } }
    recent.clear();
  };

  host.log.info('activated');
};

module.exports.deactivate = () => {
  const t = teardown;
  teardown = null;
  if (t) t();
};
