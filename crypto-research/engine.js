'use strict';

/**
 * engine.js — crypto-research. Plain Node, main process, full privileges.
 *
 * Three jobs:
 *   1. find the research library and read it (the viewer's data)
 *   2. serve a market quote for the selected ticker (market.js does the network)
 *   3. own the `[agent:cryptowatch …]` verb and the watch items it records
 *
 * Path handling is the part to read carefully. Every segment that arrives from
 * the renderer or from an agent is grammar-checked before it is joined, and
 * every read additionally resolves symlinks and prefix-checks the *resolved*
 * string against the library root. A lexical path.join is defeated by a symlink
 * inside the tree pointing out of it: the joined string stays under the root
 * and the open does not.
 */

const fs = require('node:fs');
const path = require('node:path');
const market = require('./market');

let host = null;

// A ticker is a directory segment, a URL component and a storage key, so it is
// checked once, here, with the same grammar everywhere.
const TICKER_RE = /^[A-Z0-9][A-Z0-9.-]{0,15}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Findings files. Deliberately closed: no dots, no slashes, no leading dash.
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.md$/;

const MAX_DOC_BYTES = 2 * 1024 * 1024;
const MAX_WATCH = 200;
const HOW_FAR_UP = 3; // levels above a session cwd we will look for research/

/* ------------------------------------------------------------ the library --- */

/**
 * Resolve the library root. In order:
 *   1. a folder the operator set — used as given, and NOT silently fallen back
 *      on, because reading a different library than the one they named is worse
 *      than showing nothing;
 *   2. the active session's cwd, walking up to HOW_FAR_UP levels for research/.
 */
function resolveRoot(sessionName) {
  const configured = (host.settings.get() || {}).root;
  if (configured && typeof configured === 'string' && configured.trim()) {
    const abs = path.resolve(configured.trim());
    if (!isDir(abs)) return { error: `the folder set in settings does not exist: ${abs}`, via: 'settings' };
    return { root: abs, via: 'settings' };
  }

  if (!sessionName) return { error: 'no active session, and no folder set in settings', via: 'session' };

  let scope = null;
  try {
    scope = host.sessions.fsScope(sessionName);
  } catch { /* treated as no scope */ }
  if (!scope || !scope.cwd) {
    return { error: 'the active session has no local working directory (a peer session has no local filesystem to read)', via: 'session' };
  }

  let dir = path.resolve(scope.cwd);
  for (let i = 0; i <= HOW_FAR_UP; i += 1) {
    const cand = path.join(dir, 'research');
    if (isDir(cand)) return { root: cand, via: 'session' };
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return {
    error: `no research/ folder in ${scope.cwd} or its parents — set one in settings, or run /crypto-research:crypto-research to create it`,
    via: 'session',
  };
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Confine a path to the library root, defeating symlinks.
 *
 * fsScope answers "local session, which cwd" — it is explicitly not cwd
 * confinement and not a sandbox, so this is ours to do, on every read.
 */
function confine(root, ...segments) {
  const rootReal = fs.realpathSync(root);
  const withSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;

  // Resolve each segment as we descend, so a symlink at ANY level is caught —
  // not just one at the leaf. A segment that does not exist yet is fine (the
  // caller's stat will fail honestly); what matters is that nothing which does
  // exist takes us out of the tree.
  let cur = rootReal;
  for (const seg of segments) {
    const next = path.join(cur, seg);
    let real;
    try { real = fs.realpathSync(next); } catch { real = next; }
    if (!real.startsWith(withSep)) return null;
    cur = real;
  }
  return cur;
}

/**
 * Pull score and conviction out of an assessment header.
 *
 * The corpus drifts — these documents are model-written, and the header shape
 * varies between runs (`**Score: 44/100 | Conviction: low**`,
 * `**Score: 36/100 — conviction: LOW**`). Loose patterns on purpose: a header
 * that does not parse yields a run card with no chips, never a missing run.
 */
function parseHeader(text) {
  const head = text.slice(0, 2000);
  const out = { score: null, conviction: null, title: null };

  const m1 = head.match(/score\s*[:=]?\s*(\d{1,3})\s*(?:\/\s*100)?/i);
  if (m1) {
    const n = Number(m1[1]);
    if (n >= 0 && n <= 100) out.score = n;
  }
  const m2 = head.match(/conviction\s*[:=]?\s*\**\s*(high|medium|low)/i);
  if (m2) out.conviction = m2[1].toLowerCase();

  const m3 = head.match(/^#\s+(.+)$/m);
  if (m3) out.title = m3[1].trim().slice(0, 120);

  return out;
}

function readMeta(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8');
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') {
      const id = typeof o.id === 'string' && market.ID_RE.test(o.id) ? o.id : null;
      return { id, name: typeof o.name === 'string' ? o.name.slice(0, 80) : null };
    }
  } catch { /* absent is normal for a hand-made run */ }
  return { id: null, name: null };
}

const DOC_LABELS = {
  'assessment.md': 'Assessment',
  'fundamentals.p1.md': 'Fundamentals · pass 1',
  'fundamentals.p2.md': 'Fundamentals · peer review',
  'narrative.p1.md': 'Narrative · pass 1',
  'narrative.p2.md': 'Narrative · peer review',
  'diligence.p1.md': 'Diligence · pass 1',
  'diligence.p2.md': 'Diligence · peer review',
};

function labelFor(file) {
  if (DOC_LABELS[file]) return DOC_LABELS[file];
  return file.replace(/\.md$/, '').replace(/[._]/g, ' ');
}

function buildIndex(root) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }

  const tickers = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const ticker = ent.name;
    if (!TICKER_RE.test(ticker)) continue; // anything not matching is skipped, not guessed at

    const tickerDir = path.join(root, ticker);
    let runDirs = [];
    try { runDirs = fs.readdirSync(tickerDir, { withFileTypes: true }); } catch { continue; }

    const runs = [];
    for (const r of runDirs) {
      if (!r.isDirectory() || !DATE_RE.test(r.name)) continue;
      const runDir = path.join(tickerDir, r.name);

      let files = [];
      try {
        files = fs.readdirSync(runDir)
          .filter((f) => FILE_RE.test(f))
          .sort((a, b) => (a === 'assessment.md' ? -1 : b === 'assessment.md' ? 1 : a.localeCompare(b)));
      } catch { continue; }
      if (!files.length) continue;

      let parsed = { score: null, conviction: null, title: null };
      if (files.includes('assessment.md')) {
        try {
          parsed = parseHeader(fs.readFileSync(path.join(runDir, 'assessment.md'), 'utf8'));
        } catch { /* unreadable header is no chips, not a dropped run */ }
      }

      runs.push({
        date: r.name,
        score: parsed.score,
        conviction: parsed.conviction,
        title: parsed.title,
        meta: readMeta(runDir),
        docs: files.map((f) => ({ file: f, label: labelFor(f) })),
      });
    }
    if (!runs.length) continue;

    runs.sort((a, b) => b.date.localeCompare(a.date)); // newest first

    // A delta only when BOTH runs parsed a score, so an unreadable header never
    // reads as a fall to zero.
    let delta = null;
    if (runs.length > 1 && typeof runs[0].score === 'number' && typeof runs[1].score === 'number') {
      delta = runs[0].score - runs[1].score;
    }

    const ageDays = Math.floor((Date.now() - Date.parse(`${runs[0].date}T00:00:00Z`)) / 86400000);

    tickers.push({
      ticker,
      latest: runs[0].date,
      score: runs[0].score,
      conviction: runs[0].conviction,
      coinId: runs[0].meta.id,
      name: runs[0].meta.name,
      delta,
      ageDays: Number.isFinite(ageDays) ? ageDays : null,
      runCount: runs.length,
      runs,
    });
  }

  tickers.sort((a, b) => {
    if (typeof a.score === 'number' && typeof b.score === 'number' && a.score !== b.score) return b.score - a.score;
    if (typeof a.score === 'number' !== (typeof b.score === 'number')) return typeof a.score === 'number' ? -1 : 1;
    return a.ticker.localeCompare(b.ticker);
  });
  return tickers;
}

/* ----------------------------------------------------------- watch items --- */

function loadWatch() {
  const all = host.storage.get() || {};
  return Array.isArray(all.watch) ? all.watch : [];
}

function saveWatch(list) {
  const all = host.storage.get() || {};       // not a merge: read, modify, write
  all.watch = list.slice(0, MAX_WATCH);
  return host.storage.set(all);
}

/* ------------------------------------------------------------- lifecycle --- */

module.exports.activate = (h) => {
  /*
   * Capability checks, named rather than versioned. `hostApi` stays "1" while
   * new host APIs arrive additively, so the manifest cannot say "needs a recent
   * Clodex". On an older host these calls would throw a TypeError from
   * somewhere less legible, and two failed launches quarantine the plugin with
   * nothing readable explaining why. Naming the capability stays true forever;
   * naming a version goes stale the first time something is backported.
   */
  if (!h || !h.paths || typeof h.paths.dataDir !== 'string') {
    throw new Error('this host has no host.paths.dataDir; a newer Clodex is needed for the quote cache');
  }
  if (!h.sessions || typeof h.sessions.fsScope !== 'function') {
    throw new Error('this host has no host.sessions.fsScope; a newer Clodex is needed to locate the library');
  }
  if (!h.settings || typeof h.settings.get !== 'function' || typeof h.settings.set !== 'function') {
    throw new Error('this host has no host.settings; a newer Clodex is needed for the folder setting');
  }
  if (!h.storage || typeof h.storage.get !== 'function' || typeof h.storage.set !== 'function') {
    throw new Error('this host has no host.storage; a newer Clodex is needed for the watch list');
  }
  if (!h.ipc || typeof h.ipc.handle !== 'function') {
    throw new Error('this host has no host.ipc.handle; a newer Clodex is needed to serve the viewer');
  }
  if (!h.intents || typeof h.intents.register !== 'function') {
    throw new Error('this host has no host.intents.register; a newer Clodex is needed for [agent:cryptowatch]');
  }
  if (typeof fetch !== 'function') {
    throw new Error('this engine has no global fetch; Node 18+ is needed for the quote header');
  }

  // A re-enable reuses this module object, so state starts here, not at module
  // scope. There is no library cache to reset: every handler re-reads the disk,
  // which is what makes the overlay's freshness bound "as of open" true.
  host = h;
  market.resetCache();

  host.ipc.handle('index', (sessionName) => {
    const r = resolveRoot(sessionName);
    if (!r.root) return { ok: false, error: r.error, via: r.via };
    return { ok: true, root: r.root, via: r.via, tickers: buildIndex(r.root), watch: loadWatch() };
  });

  host.ipc.handle('doc', (payload) => {
    const { sessionName, ticker, date, file } = payload || {};
    if (!TICKER_RE.test(String(ticker || ''))) return { ok: false, error: 'bad ticker' };
    if (!DATE_RE.test(String(date || ''))) return { ok: false, error: 'bad date' };
    if (!FILE_RE.test(String(file || ''))) return { ok: false, error: 'bad file name' };

    const r = resolveRoot(sessionName);
    if (!r.root) return { ok: false, error: r.error };

    let abs;
    try { abs = confine(r.root, ticker, date, file); } catch (e) { return { ok: false, error: e.message }; }
    if (!abs) return { ok: false, error: 'that path resolves outside the library' };

    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return { ok: false, error: 'not a file' };
      if (st.size > MAX_DOC_BYTES) return { ok: false, error: 'file too large to display' };
      return { ok: true, text: fs.readFileSync(abs, 'utf8'), path: abs, mtime: st.mtimeMs };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  host.ipc.handle('quote', async (payload) => {
    const { ticker, coinId, range } = payload || {};
    if (!TICKER_RE.test(String(ticker || ''))) return { state: 'failed', error: 'bad ticker' };
    return market.quote({
      dataDir: host.paths.dataDir,
      id: coinId || null,          // a run's recorded id always wins over a guess
      symbol: ticker,
      range,
    });
  });

  host.ipc.handle('setRoot', (dir) => {
    const raw = String(dir || '').trim();
    if (!raw) return { ok: false, error: 'no folder given' };
    const abs = path.resolve(raw);
    if (!isDir(abs)) return { ok: false, error: `not a folder: ${abs}` };
    if (!host.settings.set({ root: abs })) return { ok: false, error: 'could not save the setting' };
    return { ok: true, root: abs };
  });

  host.ipc.handle('clearRoot', () => {
    host.settings.set({ root: '' });
    return { ok: true };
  });

  host.ipc.handle('watchList', () => ({ ok: true, watch: loadWatch() }));

  host.ipc.handle('watchRemove', (id) => {
    const list = loadWatch().filter((w) => w.id !== id);
    if (!saveWatch(list)) return { ok: false, error: 'could not save' };
    return { ok: true, watch: list };
  });

  /*
   * The verb. `cryptowatch` rather than `watch`: verbs share ONE GLOBAL
   * namespace across every installed plugin, the second plugin to claim a name
   * does not load at all, and `watch` is exactly the name two authors pick
   * independently.
   *
   * It is off for every seat until the operator ticks it (Intents, per seat) —
   * plugin verbs are always privileged and there is no enabled-by-default. The
   * failure when it is not ticked is SILENT: parse is never consulted and
   * nothing is logged. That is in the README because it looks like a bug.
   */
  const offIntent = host.intents.register({
    verb: 'cryptowatch',
    label: 'Record a dated crypto watch item',
    promptLines: '  [agent:cryptowatch TICKER YYYY-MM-DD] why it matters   Record a dated thing to watch; shows in the Crypto overlay.',
    parse(line) {
      const m = line.match(/^\[agent:cryptowatch\s+([A-Za-z0-9.-]{1,16})(?:\s+(\d{4}-\d{2}-\d{2}))?\]\s*(.*)$/s);
      if (!m) return null;
      // Same-line remainder goes in `.body` and nothing else does: the host
      // appends the captured lines to whatever `.body` already holds, so a
      // parsed structure here would come back to the handler as wreckage.
      return { ticker: m[1].toUpperCase(), due: m[2] || null, body: m[3] || '' };
    },
    bodyMode() { return 'greedy'; },
    handler(handle, intent) {
      // A throw IS the error channel: it is caught, logged, and injected back
      // to the emitting seat as `[agent:cryptowatch] error: <message>`.
      if (!TICKER_RE.test(intent.ticker)) {
        throw new Error(`"${intent.ticker}" is not a ticker (A-Z, 0-9, dot or dash, up to 16 chars)`);
      }
      const note = String(intent.body || '').trim().slice(0, 600);
      if (!note) throw new Error('a watch item needs a reason — put it after the bracket');
      if (intent.due && Number.isNaN(Date.parse(`${intent.due}T00:00:00Z`))) {
        throw new Error(`"${intent.due}" is not a real date`);
      }

      // Exactly once per matched line, by construction — no de-duplication
      // guard needed around this write.
      const list = loadWatch();
      list.unshift({
        id: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        ticker: intent.ticker,
        due: intent.due,
        note,
        by: handle.name || 'an agent',
        at: new Date().toISOString(),
      });
      if (!saveWatch(list)) throw new Error('could not save the watch item');

      // Events are unbuffered and every surface pulls its own state on open, so
      // this only saves a timer. `null` payload: an invalidation hint carries no
      // data, and a count would tell every workspace how busy the others are.
      try { host.events.emit('watch-changed', null, 'all'); } catch { /* optional */ }

      handle.inject(`[cryptowatch] recorded ${intent.ticker}${intent.due ? ` due ${intent.due}` : ''} — ${list.length} item(s) on the list.`);
      host.log.info(`watch item recorded: ${intent.ticker} by ${handle.name}`);
    },
  });

  module.exports._offIntent = offIntent;
  host.log.info('activated');
};

module.exports.deactivate = () => {
  // The host removes surfaces wholesale, but the verb is ours to release: a
  // stale registration would refuse the name to the next activation.
  if (typeof module.exports._offIntent === 'function') {
    try { module.exports._offIntent(); } catch { /* already gone */ }
  }
  module.exports._offIntent = null;
  market.resetCache();
  host = null;
};

// Exported for the tests; not part of the plugin surface.
module.exports._parseHeader = parseHeader;
module.exports._buildIndex = (root) => buildIndex(root);
