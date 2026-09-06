'use strict';

/**
 * stock-assessments — engine half. Read-only, by design: this plugin surfaces
 * research artifacts that are point-in-time documents (the workspace's own rule
 * is "never edit an old assessment, write a new dated one"), so there is no
 * write path here at all. The single mutation is a setting: which folder to
 * read.
 *
 * Layout it expects, and the only thing it knows about the workspace:
 *
 *   <root>/assessments/<TICKER>/<YYYY-MM-DD>/assessment.md
 *                                           /fundamentals.p1.md
 *                                           /diligence.p2.md   … etc
 *
 * Anything that does not fit that shape is skipped rather than guessed at.
 */

const fs = require('node:fs');
const path = require('node:path');

// The quote half. Kept in its own file because it is the only part of this
// plugin that reaches the network, and the only part that can be slow.
const market = require('./market');

const ASSESS_DIR = 'assessments';

// Must equal the directory name and the manifest id — the host refuses a
// mismatch — and it is also the namespace the bundled skill and agents are
// reached under (`/stock-assessments:stock-research`).
const PLUGIN_ID = 'stock-assessments';

// Directory-name grammars. These are the containment-relevant checks: every
// renderer-supplied path segment must match one before it is joined to a path,
// and none of them can match '.' or '..' (both require the first character to
// be alphanumeric, and '.' is not in the leading class).
const TICKER_RE = /^[A-Z0-9][A-Z0-9.-]{0,15}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOC_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.md$/;

// A findings file can be long; an assessment is a few dozen KB. The cap exists
// so a stray multi-megabyte file in the folder cannot be structured-cloned
// across the IPC boundary and wedge a window.
const MAX_DOC_BYTES = 1024 * 1024;
// Only the head of an assessment is parsed for score/conviction/title.
const HEADER_BYTES = 8192;

let host = null;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

/**
 * Join `parts` under `root` and refuse anything that lands outside it.
 *
 * Two passes, because neither catches the other's case: the grammar test
 * rejects a segment that could traverse, and the prefix test rejects a
 * traversal assembled some other way. `fsScope` guarantees neither — it hands
 * out a cwd and says nothing about confinement (plugin-api §4).
 */
function safeJoin(root, parts, grammars) {
  const base = path.resolve(root);
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i];
    if (typeof seg !== 'string' || !grammars[i].test(seg)) return null;
  }
  const p = path.resolve(base, ...parts);
  if (p !== base && !p.startsWith(base + path.sep)) return null;
  return p;
}

/**
 * The real path of `p`, if it is still inside `root` after symlinks resolve.
 *
 * safeJoin is lexical, so a symlink INSIDE the assessments tree pointing out of
 * it would pass and then read anything on disk. Reads go through here; the
 * listing walk does not, because it only ever reports names it read from a
 * directory entry.
 */
function realWithin(root, p) {
  let real;
  let realRoot;
  try {
    real = fs.realpathSync(p);
    realRoot = fs.realpathSync(root);
  } catch (_) {
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  return real;
}

/**
 * Walk up from `start` looking for a directory that has an `assessments/`
 * child. Four levels, so a session rooted at `~/projects/stocks/plugins/foo`
 * still finds the workspace, and a session in an unrelated project finds
 * nothing rather than something.
 */
function findRootUpwards(start) {
  let d = path.resolve(start);
  for (let i = 0; i < 4; i += 1) {
    if (isDir(path.join(d, ASSESS_DIR))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

/**
 * Where to read from, and why — the `via` field is shown in the UI so the
 * operator can tell a configured root from a guessed one.
 *
 * The configured root wins over the session's cwd deliberately: it is an
 * explicit operator choice, and a viewer that silently followed whichever
 * session happened to be focused would show a different library depending on
 * where the user clicked from.
 */
function resolveRoot(sessionName) {
  const configured = (host.settings.get() || {}).root;
  if (typeof configured === 'string' && configured) {
    if (isDir(path.join(configured, ASSESS_DIR))) {
      return { root: path.resolve(configured), via: 'settings' };
    }
    // Configured but unusable is an error, NOT a fall-through to the session:
    // silently reading a different library than the one the operator named is
    // the failure mode this whole branch exists to prevent, and it would leave
    // a stale setting invisible behind a plausible-looking listing.
    return {
      root: null,
      via: 'settings',
      error: `the chosen folder has no ${ASSESS_DIR}/ inside it — ${configured}`,
    };
  }

  if (typeof sessionName === 'string' && sessionName) {
    // fsScope, not a raw cwd read: it is the host guard that refuses a remote
    // session, whose filesystem is on another machine entirely.
    const scope = host.sessions.fsScope(sessionName);
    if (scope && scope.error) {
      return { root: null, via: 'session', error: scope.error };
    }
    if (scope && scope.cwd) {
      const found = findRootUpwards(scope.cwd);
      if (found) return { root: found, via: 'session' };
      return { root: null, via: 'session', error: 'no assessments/ folder here' };
    }
  }

  return { root: null, via: 'none', error: 'no active session with a working directory' };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function readHead(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* already gone */ }
    }
  }
}

/**
 * Pull the display header out of an assessment.
 *
 * The corpus is hand-written by a model and the header shape drifts across
 * runs — `**Score: 44/100 | Conviction: low**`, `**Score: 36/100 — conviction:
 * LOW**`, and a `## Verdict` line in between are all real. So these patterns
 * are loose on purpose and every field is optional: a header that does not
 * parse yields a card with a title and no score chip, never a skipped run.
 */
function parseAssessmentHead(text) {
  const out = { title: '', company: '', score: null, conviction: '' };

  const titleLine = text.split('\n').find((l) => /^#\s+\S/.test(l));
  if (titleLine) {
    out.title = titleLine.replace(/^#\s+/, '').trim();
    // "Figma (FIG) — Assessment — 2026-08-05" -> "Figma (FIG)". The em dash is
    // the separator every run in this corpus uses; a hyphen is accepted too.
    out.company = out.title.split(/\s+[—-]\s+Assessment/i)[0].trim();
  }

  const score = text.match(/Score:\s*\**\s*(\d{1,3})\s*\/\s*100/i);
  if (score) {
    const n = Number(score[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 100) out.score = n;
  }

  const conv = text.match(/conviction:?\s*\**\s*(high|medium|low)/i);
  if (conv) out.conviction = conv[1].toLowerCase();

  return out;
}

// Turns `fundamentals.p1.md` into `Fundamentals · pass 1`, and leaves anything
// unrecognised as its own filename rather than inventing a label for it.
function labelFor(file) {
  const base = file.replace(/\.md$/, '');
  if (base === 'assessment') return 'Assessment';
  const m = base.match(/^([a-zA-Z0-9_-]+)\.p(\d+)$/);
  if (m) return `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} · pass ${m[2]}`;
  return base;
}

// assessment.md always leads — it is the document, the rest is its evidence.
// Everything else sorts by name, which happens to group role then pass.
function docSort(a, b) {
  if (a.file === 'assessment.md') return -1;
  if (b.file === 'assessment.md') return 1;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

function listRuns(root, ticker) {
  const tickerDir = safeJoin(root, [ASSESS_DIR, ticker], [/^assessments$/, TICKER_RE]);
  if (!tickerDir) return [];
  let entries;
  try {
    entries = fs.readdirSync(tickerDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const runs = [];
  for (const e of entries) {
    if (!e.isDirectory() || !DATE_RE.test(e.name)) continue;
    const runDir = path.join(tickerDir, e.name);

    let files;
    try {
      files = fs.readdirSync(runDir, { withFileTypes: true });
    } catch (_) {
      continue; // vanished between the two reads — skip, don't fail the listing
    }

    const docs = [];
    for (const f of files) {
      if (!f.isFile() || !DOC_RE.test(f.name)) continue;
      let size = 0;
      try { size = fs.statSync(path.join(runDir, f.name)).size; } catch (_) { /* keep 0 */ }
      docs.push({ file: f.name, label: labelFor(f.name), size });
    }
    if (!docs.length) continue;
    docs.sort(docSort);

    const head = docs.some((d) => d.file === 'assessment.md')
      ? parseAssessmentHead(readHead(path.join(runDir, 'assessment.md'), HEADER_BYTES))
      : { title: '', company: '', score: null, conviction: '' };

    runs.push({ date: e.name, dir: runDir, docs, ...head });
  }

  // Newest first. Dates are YYYY-MM-DD, so string order is chronological.
  runs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return runs;
}

// ---------------------------------------------------------------------------
// Staleness
//
// The workspace's own re-assessment rule (CLAUDE.md) has four triggers: the
// last assessment is >=90 days old, a watched catalyst's date passed, earnings
// just happened, or the position moved >=10pp against SPY.
//
// Only the first two are computable from what is on disk. The last two need
// price and calendar data, and a research viewer has no business fetching
// either — so they are deliberately not implemented rather than approximated.
// What this produces is a prompt to look, never a verdict.
// ---------------------------------------------------------------------------

const STALE_DAYS = 90;

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Whole days between two YYYY-MM-DD strings.
 *
 * Both are parsed as UTC midnight so the subtraction is exact: a local-time
 * parse straddling a DST boundary yields 89.96 days and floors to the wrong
 * answer, which is precisely the kind of off-by-one that makes a staleness
 * chip untrustworthy on one day of the year.
 */
function daysBetween(fromISO, toISO) {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Parse watchlist.md into { TICKER: [ISO dates] }.
 *
 * The file is prose — one bullet per ticker, catalyst dates written inline
 * among unconfirmed guesses and hedges. So this extracts every ISO date on the
 * ticker's line and nothing else: no attempt is made to tell a confirmed date
 * from an estimated one, because that distinction lives in the prose and
 * guessing at it would put false precision on a chip.
 */
function parseWatchlist(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, 'watchlist.md'), 'utf8');
  } catch (_) {
    return {}; // no watchlist is normal — staleness then rests on age alone
  }
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*[-*]\s+([A-Z][A-Z0-9.-]{0,15})\b/);
    if (!m) continue;
    const dates = line.match(/\d{4}-\d{2}-\d{2}/g) || [];
    // Deduped and sorted; a line often repeats a date across two clauses.
    out[m[1]] = [...new Set(dates)].sort();
  }
  return out;
}

/**
 * Why this ticker might want a re-run, as a list of human-readable reasons.
 *
 * An empty list means "nothing on disk says so" — NOT "no need to look". The
 * two triggers this cannot see are the two most likely to fire.
 */
function stalenessFor(latestDate, catalystDates, today) {
  const age = daysBetween(latestDate, today);
  const reasons = [];

  if (Number.isFinite(age) && age >= STALE_DAYS) {
    reasons.push(`last assessment is ${age} days old`);
  }

  // A catalyst dated after the last run and not in the future has come and gone
  // unassessed. Today counts as passed: a date lands during market hours and
  // the assessment that would cover it does not exist yet.
  const passed = (catalystDates || []).filter(
    (d) => d > latestDate && d <= today,
  );
  for (const d of passed) reasons.push(`catalyst ${d} passed`);

  const upcoming = (catalystDates || []).filter((d) => d > today);
  return {
    ageDays: Number.isFinite(age) ? age : null,
    reasons,
    passedCount: passed.length,
    nextCatalyst: upcoming.length ? upcoming[0] : null,
    nextCatalystInDays: upcoming.length ? daysBetween(today, upcoming[0]) : null,
  };
}

function buildIndex(root) {
  const base = path.join(root, ASSESS_DIR);
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const watchlist = parseWatchlist(root);
  const today = todayISO();

  const tickers = [];
  for (const e of entries) {
    if (!e.isDirectory() || !TICKER_RE.test(e.name)) continue;
    const runs = listRuns(root, e.name);
    if (!runs.length) continue;
    const latest = runs[0];
    tickers.push({
      ticker: e.name,
      company: latest.company || '',
      runs,
      latestDate: latest.date,
      latestScore: latest.score,
      latestConviction: latest.conviction,
      // Signed delta against the previous run, computed here so the renderer
      // never has to decide what "previous" means. Null unless BOTH runs
      // scored — an unparsed header must not read as a fall to zero.
      trend: runs.length > 1 && Number.isFinite(runs[0].score) && Number.isFinite(runs[1].score)
        ? runs[0].score - runs[1].score
        : null,
      stale: stalenessFor(latest.date, watchlist[e.name], today),
    });
  }

  tickers.sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  return tickers;
}

// ---------------------------------------------------------------------------
// Re-running research
//
// `inject` types into a session's input as if the operator had typed it. That
// makes this the one thing here that CAUSES work rather than displaying it, and
// a /stock-research run is expensive — several subagents and a lot of web
// research. Three properties of inject shape everything below (plugin-api §4):
//
//   - It is fire-and-forget. It returns undefined, is not async, and cannot
//     tell you whether the text was delivered, queued behind a mid-turn hold,
//     or dropped into a dead session. So a click can produce no visible effect,
//     and the natural response to that is to click again.
//   - A newline may submit early, splitting one message into several. The
//     command is built as a single line and collapsed before it is sent.
//   - Anything not a string is coerced, never rejected — a bug in the value
//     becomes visible text in the operator's prompt.
//
// The answers: only ever offer the session this window is already showing, and
// only when it is a claude seat rooted in the library being viewed; record the
// request so the UI can show a cooldown in place of a button whose delivery it
// cannot confirm.
// ---------------------------------------------------------------------------

// Collapse to one line. Built from strings, not regex literals: a raw control
// byte in a literal is invisible and does not survive reformatting, at which
// point the class silently narrows and the collapse stops happening with no
// error anywhere (plugin-api §4).
const ANSI = new RegExp('\\u001B\\[[0-9;?]*[a-zA-Z]|\\u001B\\][^\\u0007]*\\u0007', 'g');
const CTRL = new RegExp('[\\u0000-\\u001F\\u007F]+', 'g');
const RUNS = new RegExp('\\s+', 'g');

function oneLine(text) {
  return String(text).replace(ANSI, '').replace(CTRL, ' ').replace(RUNS, ' ').trim();
}

// A click cannot be confirmed delivered, so it is remembered instead. Long
// enough that a parked inject has surfaced and a run has visibly started;
// short enough not to block a deliberate second look at a moving story.
const COOLDOWN_MS = 15 * 60 * 1000;

function recentRequests() {
  const saved = (host.storage.get() || {}).requests;
  if (!saved || typeof saved !== 'object') return {};
  const cutoff = Date.now() - COOLDOWN_MS;
  const out = {};
  for (const [k, v] of Object.entries(saved)) {
    // Prune on read: nothing else runs, so an entry that aged out while the app
    // was closed must not come back as a live cooldown.
    if (typeof v === 'number' && v > cutoff) out[k] = v;
  }
  return out;
}

function noteRequest(ticker) {
  const requests = recentRequests();
  requests[ticker] = Date.now();
  // storage.set replaces the whole file, so merge into what was read.
  const all = host.storage.get() || {};
  all.requests = requests;
  host.storage.set(all);
  return requests;
}

/**
 * Can THIS window's active session run the research skill against THIS library?
 *
 * Deliberately not a session picker. Enumerating sessions and choosing one for
 * the operator would mean guessing which agent should absorb an expensive run,
 * and would happily aim at another workspace — writing assessments/ into an
 * unrelated repo. Restricting it to the session already on screen makes the
 * workspace question answer itself.
 */
function describeRunner(sessionName, root) {
  if (typeof sessionName !== 'string' || !sessionName) {
    return { ok: false, reason: 'no active session in this window' };
  }
  const handle = host.sessions.get(sessionName);
  if (!handle) return { ok: false, reason: 'no active session in this window' };
  if (handle.type !== 'claude') {
    // A bash or codex seat has no /stock-research; injecting there types a line
    // that simply fails.
    return { ok: false, name: sessionName, reason: `${sessionName} is a ${handle.type} session — no skills` };
  }
  if (!handle.isAlive()) {
    return { ok: false, name: sessionName, reason: `${sessionName} is not running` };
  }
  // fsScope, not handle.cwd: it is the host guard that refuses a peer session,
  // whose filesystem is on another machine entirely.
  const scope = host.sessions.fsScope(sessionName);
  if (!scope || scope.error || !scope.cwd) {
    return { ok: false, name: sessionName, reason: scope && scope.error === 'remote'
      ? `${sessionName} runs on another machine`
      : `${sessionName} has no working directory` };
  }
  const found = findRootUpwards(scope.cwd);
  if (found !== path.resolve(root)) {
    return { ok: false, name: sessionName, reason: `${sessionName} is not in this workspace` };
  }
  return { ok: true, name: sessionName };
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

module.exports.activate = (h) => {
  /*
   * Capability checks first, and named rather than versioned.
   *
   * `hostApi` stays "1" while new host APIs arrive additively, so the manifest
   * cannot say "needs a recent Clodex". On an older host the call below would
   * return undefined and throw a TypeError somewhere less legible, and two
   * failed launches hold the plugin back with nothing readable explaining why.
   * Naming the missing capability stays true forever; naming a version number
   * goes stale the first time something is backported.
   */
  if (!h || !h.paths || typeof h.paths.dataDir !== 'string') {
    throw new Error('this host has no host.paths.dataDir; a newer Clodex is needed for the quote cache');
  }
  if (!h.sessions || typeof h.sessions.fsScope !== 'function') {
    throw new Error('this host has no host.sessions.fsScope; a newer Clodex is needed to locate the workspace');
  }
  if (!h.settings || typeof h.settings.get !== 'function' || typeof h.settings.set !== 'function') {
    throw new Error('this host has no host.settings; a newer Clodex is needed for the folder setting');
  }
  if (!h.storage || typeof h.storage.get !== 'function' || typeof h.storage.set !== 'function') {
    throw new Error('this host has no host.storage; a newer Clodex is needed for the re-assess cooldown');
  }
  if (!h.ipc || typeof h.ipc.handle !== 'function') {
    throw new Error('this host has no host.ipc.handle; a newer Clodex is needed to serve the viewer');
  }
  if (typeof fetch !== 'function') {
    throw new Error('this engine has no global fetch; Node 18+ is needed for the quote header');
  }

  // A re-enable reuses this module object, so state starts here, not at module
  // scope. There is no cache to reset: every handler re-reads the disk, which
  // is what makes the overlay's freshness bound "as of open" true.
  host = h;
  // Same reason: the quote module's memory cache would otherwise survive a
  // disable/enable cycle and serve prices from the previous activation.
  market.resetCache();

  host.ipc.handle('index', (sessionName) => {
    const r = resolveRoot(sessionName);
    if (!r.root) return { ok: false, error: r.error || 'not found', via: r.via };
    return {
      ok: true,
      root: r.root,
      via: r.via,
      tickers: buildIndex(r.root),
      runner: describeRunner(sessionName, r.root),
      requests: recentRequests(),
    };
  });

  host.ipc.handle('doc', (payload) => {
    const { sessionName, ticker, date, file } = payload || {};
    const r = resolveRoot(sessionName);
    if (!r.root) return { ok: false, error: r.error || 'not found' };

    const p = safeJoin(r.root, [ASSESS_DIR, ticker, date, file], [/^assessments$/, TICKER_RE, DATE_RE, DOC_RE]);
    if (!p) return { ok: false, error: 'invalid document path' };
    const real = realWithin(r.root, p);
    if (!real) return { ok: false, error: 'document is outside the assessments folder' };

    let stat;
    try {
      stat = fs.statSync(real);
    } catch (_) {
      return { ok: false, error: 'document not found' };
    }
    if (!stat.isFile()) return { ok: false, error: 'not a file' };
    if (stat.size > MAX_DOC_BYTES) {
      return { ok: false, error: `document is ${Math.round(stat.size / 1024)}KB — too large to display` };
    }

    try {
      return { ok: true, text: fs.readFileSync(real, 'utf8'), path: real, mtime: stat.mtimeMs };
    } catch (e) {
      return { ok: false, error: `could not read: ${e.message}` };
    }
  });

  // The picked path is an operator gesture, not an authorization: it is a
  // string by the time it lands here, so it is validated at the point of use
  // (plugin-api §5). "Valid" means exactly one thing — it has an assessments/
  // folder — because a root that does not is a setting that shows an empty
  // viewer forever with nothing to read.
  host.ipc.handle('setRoot', (dir) => {
    if (typeof dir !== 'string' || !dir) return { ok: false, error: 'a folder path is required' };
    const abs = path.resolve(dir);
    if (!isDir(abs)) return { ok: false, error: 'not a folder' };
    if (!isDir(path.join(abs, ASSESS_DIR))) {
      return { ok: false, error: `that folder has no ${ASSESS_DIR}/ inside it` };
    }
    if (!host.settings.set({ root: abs })) return { ok: false, error: 'could not save the setting' };
    return { ok: true, root: abs };
  });

  /**
   * Type `/stock-assessments:stock-research <TICKER>` into this window's
   * active session.
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
    if (!r.root) return { ok: false, error: r.error || 'not found' };

    // Only a ticker that actually has assessments on disk. This is not a
    // "research anything" button — it re-runs something already in the library,
    // which keeps the injected text bounded by what the directory walk found.
    if (!isDir(path.join(r.root, ASSESS_DIR, ticker))) {
      return { ok: false, error: `no assessments folder for ${ticker}` };
    }

    const runner = describeRunner(sessionName, r.root);
    if (!runner.ok) return { ok: false, error: runner.reason };

    // The cooldown is enforced HERE, not just in the renderer that hides the
    // button. Every window draws its own button from its own last listing, so
    // a second window still shows one after the first has fired — and two
    // clicks means two full research runs. The engine is the only half that
    // sees all of them.
    const already = recentRequests()[ticker];
    if (Number.isFinite(already)) {
      const mins = Math.max(1, Math.round((Date.now() - already) / 60000));
      return {
        ok: false,
        error: `${ticker} was already sent for re-assessment ${mins}m ago`,
        requests: recentRequests(),
      };
    }

    const handle = host.sessions.get(runner.name);
    if (!handle || !handle.isAlive()) {
      return { ok: false, error: `${runner.name} is not running` };
    }

    // One line, collapsed, built from a ticker that has already passed
    // TICKER_RE — so there is nothing in it that could split the turn.
    //
    // The NAMESPACED name, because the skill now ships in this plugin's own
    // skills/ bundle and a bundled skill is invoked as `/<plugin-id>:<skill>`.
    // The bare `/stock-research` would resolve only against a copy in the
    // operator's skill library — a second, silently divergent copy of this file
    // — so naming it here would make the button depend on something outside the
    // plugin it lives in.
    //
    // This is safe for the seat that can click: the footer button is REMOVED
    // and the overlay REFUSED while a seat without this plugin is active
    // (plugin-api §2.1), so the runner always holds the plugin. The one gap is
    // a seat ticked mid-session — bundle content is written at spawn, so its
    // skills arrive at that seat's NEXT start. Until then this types a skill
    // name the seat cannot resolve, which fails visibly rather than running the
    // wrong copy of the skill.
    const command = oneLine(`/${PLUGIN_ID}:stock-research ${ticker}`);
    handle.inject(command);

    // inject returns undefined in every case, so this records that the request
    // was MADE, never that it arrived. The UI says so.
    const requests = noteRequest(ticker);
    host.log.info(`injected "${command}" into ${runner.name}`);
    return { ok: true, session: runner.name, command, requests };
  });

  /**
   * A market quote for the ticker pane's header.
   *
   * Async, so it is awaited by the host and its rejection would reach the
   * renderer as { ok: false } — but it is written not to reject: an
   * unreachable source is a result here, because a research viewer that
   * cannot say WHY a number is missing is the thing this avoids.
   */
  host.ipc.handle('quote', async (payload) => {
    const p = payload || {};
    const cfg = host.settings.get() || {};
    const contact = typeof cfg.secContact === 'string' ? cfg.secContact.trim() : '';
    return market.quote({
      dataDir: host.paths.dataDir,
      ticker: typeof p.ticker === 'string' ? p.ticker.toUpperCase() : '',
      range: typeof p.range === 'string' ? p.range : '1mo',
      // Only an address the operator typed into settings is ever sent, and
      // only to the SEC, whose fair-access policy asks for one. Blank means
      // the market-cap leg simply does not run.
      secContact: /.+@.+\..+/.test(contact) ? contact : '',
      log: host.log,
    });
  });

  host.ipc.handle('clearRoot', () => {
    // '' rather than a delete: settings.set shallow-merges, so it cannot remove
    // a key. resolveRoot treats an empty string as unset.
    host.settings.set({ root: '' });
    return { ok: true };
  });

  // Reveal-in-Finder is renderer-side (rhost.ui.openPath), but the renderer
  // must never assemble that path itself — it gets it from a listing this half
  // produced, so what opens is always a directory that was actually walked.
  host.log.info('activated');
};

module.exports.deactivate = () => {
  market.resetCache();
  host = null;
};
