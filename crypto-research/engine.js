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

// The skill is invoked as `/<plugin-id>:<skill>`, so the id is needed verbatim.
// A bare `/crypto-research` would resolve only against a copy in the operator's
// personal skill library — a second, silently divergent copy of the same file.
const PLUGIN_ID = 'crypto-research';

// An assessment older than this looks due. Same threshold as the `stale · Nd`
// chip the viewer already draws, so the two never disagree on screen.
const STALE_DAYS = 30;

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

  const found = findLibraryUpwards(scope.cwd);
  if (found) return { root: found, via: 'session' };
  return {
    error: `no research/ folder in ${scope.cwd} or its parents — set one in settings, or run /crypto-research:crypto-research to create it`,
    via: 'session',
  };
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Walk up from `cwd` looking for a research/ folder. Returns it, or null.
 *
 * Shared by resolveRoot and by the re-run guard, so the question "which library
 * does this session belong to" is answered by one piece of code — two copies of
 * this loop would eventually disagree about HOW_FAR_UP and the button would
 * offer to write into a library the viewer is not showing.
 */
function findLibraryUpwards(cwd) {
  let dir = path.resolve(cwd);
  for (let i = 0; i <= HOW_FAR_UP; i += 1) {
    const cand = path.join(dir, 'research');
    if (isDir(cand)) return cand;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
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

/**
 * Why this ticker might want a re-run, as human-readable reasons.
 *
 * Two sources, both on disk: the age of the newest assessment, and any watch
 * item whose date has arrived since that assessment was written — a dated thing
 * an agent said to watch for, which has now happened unassessed.
 */
function dueReasonsFor(latestDate, ageDays, watchItems) {
  const reasons = [];
  if (Number.isFinite(ageDays) && ageDays >= STALE_DAYS) {
    reasons.push(`last assessment is ${ageDays} days old`);
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const w of watchItems || []) {
    // String compare is correct for ISO dates and avoids a timezone question.
    // `<= today` counts today as passed: a date lands during the day and the
    // assessment that would cover it does not exist yet.
    if (w.due && w.due > latestDate && w.due <= today) {
      reasons.push(`watch item ${w.due} passed — ${String(w.note || '').slice(0, 60)}`);
    }
  }
  return reasons;
}

function buildIndex(root, watch) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }

  // Grouped once, not re-scanned per ticker.
  const watchByTicker = {};
  for (const w of watch || []) {
    if (!w || typeof w.ticker !== 'string') continue;
    (watchByTicker[w.ticker] = watchByTicker[w.ticker] || []).push(w);
  }

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
      // Why a re-run might be wanted, in words the confirm dialog can show.
      // An empty list means "nothing on disk says so" — NOT "no reason to look":
      // the triggers that matter most for a token (a depeg, an exploit, an
      // unlock landing early) leave no trace in this directory at all.
      dueReasons: dueReasonsFor(runs[0].date, ageDays, watchByTicker[ticker]),
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

/* --------------------------------------------------------- re-running --- */
/*
 * `inject` types into a session's input as if the operator had typed it. That
 * makes this the one thing in this plugin that CAUSES work rather than showing
 * it, and a crypto-research run is expensive — two subagents, an assessor, and
 * a lot of web research. Three properties of inject shape everything below:
 *
 *   - It is fire-and-forget: it returns undefined and cannot say whether the
 *     text was delivered, parked behind a mid-turn hold, or dropped into a dead
 *     session. So a click can produce no visible effect, and the natural
 *     response to that is to click again.
 *   - A newline may submit early, splitting one message into several. The
 *     command is built as a single line and collapsed before it is sent.
 *   - Anything not a string is coerced, never rejected — so a bug in the value
 *     becomes visible text in the operator's prompt.
 *
 * The answers: only ever offer the session this window is already showing, and
 * only when it is a live claude seat rooted in the library being viewed; then
 * record the request, so the UI can show a cooldown in place of a button whose
 * delivery it cannot confirm.
 */

// Collapse to one line. Built from strings rather than regex literals: a raw
// control byte inside a literal is invisible and does not survive reformatting,
// at which point the class silently narrows and the collapse stops happening
// with no error anywhere.
const ANSI = new RegExp('\\u001B\\[[0-9;?]*[a-zA-Z]|\\u001B\\][^\\u0007]*\\u0007', 'g');
const CTRL = new RegExp('[\\u0000-\\u001F\\u007F]+', 'g');
const RUNS = new RegExp('\\s+', 'g');

function oneLine(text) {
  return String(text).replace(ANSI, '').replace(CTRL, ' ').replace(RUNS, ' ').trim();
}

// A click cannot be confirmed delivered, so it is remembered instead. Long
// enough that a parked inject has surfaced and a run has visibly started; short
// enough not to block a deliberate second look at a moving story.
const COOLDOWN_MS = 15 * 60 * 1000;

function recentRequests() {
  const saved = (host.storage.get() || {}).requests;
  if (!saved || typeof saved !== 'object') return {};
  const cutoff = Date.now() - COOLDOWN_MS;
  const out = {};
  // Pruned on read: nothing else runs, so an entry that aged out while the app
  // was closed must not come back as a live cooldown.
  for (const [k, v] of Object.entries(saved)) {
    if (typeof v === 'number' && v > cutoff) out[k] = v;
  }
  return out;
}

function noteRequest(ticker) {
  const requests = recentRequests();
  requests[ticker] = Date.now();
  const all = host.storage.get() || {};   // read, modify, write — set replaces
  all.requests = requests;
  host.storage.set(all);
  return requests;
}

/**
 * Can THIS window's active session run the skill against THIS library?
 *
 * Deliberately not a session picker. Enumerating sessions and choosing one for
 * the operator would mean guessing which agent should absorb an expensive run,
 * and would happily aim at another workspace — writing research/ into an
 * unrelated repo. Restricting it to the session already on screen makes the
 * workspace question answer itself.
 */
function describeRunner(sessionName, root) {
  if (typeof sessionName !== 'string' || !sessionName) {
    return { ok: false, reason: 'no active session in this window' };
  }
  let handle = null;
  try { handle = host.sessions.get(sessionName); } catch { /* treated as absent */ }
  if (!handle) return { ok: false, reason: 'no active session in this window' };
  if (handle.type !== 'claude') {
    // A bash or codex seat has no skills; injecting there types a line that
    // simply fails in front of the operator.
    return { ok: false, name: sessionName, reason: `${sessionName} is a ${handle.type} session — no skills` };
  }
  if (typeof handle.isAlive === 'function' && !handle.isAlive()) {
    return { ok: false, name: sessionName, reason: `${sessionName} is not running` };
  }
  // fsScope, not handle.cwd: it is the host guard that refuses a peer session,
  // whose filesystem is on another machine entirely.
  let scope = null;
  try { scope = host.sessions.fsScope(sessionName); } catch { /* treated as no scope */ }
  if (!scope || scope.error || !scope.cwd) {
    return {
      ok: false,
      name: sessionName,
      reason: scope && scope.error === 'remote'
        ? `${sessionName} runs on another machine`
        : `${sessionName} has no working directory`,
    };
  }
  // The seat must belong to the library on screen. A settings-pinned root is
  // the case that makes this necessary: the viewer may be showing a library the
  // active seat has nothing to do with, and injecting there would write a run
  // into a different repo than the one being read.
  const found = findLibraryUpwards(scope.cwd);
  if (!found || path.resolve(found) !== path.resolve(root)) {
    return { ok: false, name: sessionName, reason: `${sessionName} is not in this library's workspace` };
  }
  return { ok: true, name: sessionName };
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
    throw new Error('this host has no host.storage; a newer Clodex is needed for the watch list and the re-assess cooldown');
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
    const watch = loadWatch();
    return {
      ok: true,
      root: r.root,
      via: r.via,
      tickers: buildIndex(r.root, watch),
      watch,
      runner: describeRunner(sessionName, r.root),
      requests: recentRequests(),
    };
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

  /**
   * Type `/crypto-research:crypto-research <TICKER>` into this window's active
   * session.
   *
   * Every guard is re-run here rather than trusted from the listing the button
   * was drawn from: that listing is as old as the last overlay open, and the
   * session may have exited, changed workspace or been replaced since.
   */
  host.ipc.handle('rerun', (payload) => {
    const { sessionName, ticker } = payload || {};
    if (typeof ticker !== 'string' || !TICKER_RE.test(ticker)) {
      return { ok: false, error: 'invalid ticker' };
    }

    const r = resolveRoot(sessionName);
    if (!r.root) return { ok: false, error: r.error || 'no library' };

    // Only a ticker that already has a folder on disk. This is not a "research
    // anything" button — it re-runs something the directory walk found, which
    // keeps the injected text bounded by what is actually in the library.
    if (!isDir(path.join(r.root, ticker))) {
      return { ok: false, error: `no research folder for ${ticker}` };
    }

    const runner = describeRunner(sessionName, r.root);
    if (!runner.ok) return { ok: false, error: runner.reason };

    // The cooldown is enforced HERE, not only in the renderer that hides the
    // button. Every window draws its own button from its own last listing, so a
    // second window still shows one after the first has fired — and two clicks
    // means two full research runs. The engine is the only half that sees all
    // of them.
    const already = recentRequests()[ticker];
    if (Number.isFinite(already)) {
      const mins = Math.max(1, Math.round((Date.now() - already) / 60000));
      return {
        ok: false,
        error: `${ticker} was already sent for re-assessment ${mins}m ago`,
        requests: recentRequests(),
      };
    }

    let handle = null;
    try { handle = host.sessions.get(runner.name); } catch { /* treated as absent */ }
    if (!handle || (typeof handle.isAlive === 'function' && !handle.isAlive())) {
      return { ok: false, error: `${runner.name} is not running` };
    }

    /*
     * One line, collapsed, built from a ticker that has already passed
     * TICKER_RE — so there is nothing in it that could split the turn.
     *
     * The NAMESPACED skill name, because the skill ships in this plugin's own
     * skills/ bundle. This is safe for the seat that can click: the footer
     * button is removed and the overlay refused for a seat without this plugin,
     * so the runner always holds it. The one gap is a seat ticked mid-session —
     * bundle content is written at spawn, so its skills arrive at that seat's
     * NEXT start. Until then this types a skill name the seat cannot resolve,
     * which fails visibly rather than running some other copy of the skill.
     *
     * The ticker, not the coin id or the project name: the skill re-resolves
     * identity through CoinGecko's search itself, and a symbol is what the
     * operator sees on the row they clicked.
     */
    const command = oneLine(`/${PLUGIN_ID}:crypto-research ${ticker}`);
    handle.inject(command);

    // inject returns undefined in every case, so this records that the request
    // was MADE, never that it arrived. The UI says exactly that.
    const requests = noteRequest(ticker);
    host.log.info(`injected "${command}" into ${runner.name}`);
    return { ok: true, session: runner.name, command, requests };
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
module.exports._buildIndex = (root, watch) => buildIndex(root, watch);
module.exports._dueReasonsFor = dueReasonsFor;
module.exports._oneLine = oneLine;
