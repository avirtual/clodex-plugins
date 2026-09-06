'use strict';

/**
 * market.js — the quote half of crypto-research. Required by engine.js only;
 * it never touches the renderer, and it holds no state outliving a call beyond
 * an in-process memory cache the engine resets on activate().
 *
 * Three keyless public sources, all read-only, no account, no key:
 *
 *   CoinGecko /search        name or symbol -> the canonical coin id
 *   CoinGecko /coins/markets price, caps, supply, ATH, 24h/7d/30d change
 *   CoinGecko /market_chart  the daily series behind the sparkline
 *   alternative.me /fng      Fear & Greed, as market context
 *
 * THE FAILURE MODE THAT SHAPED THIS FILE. `/coins/markets` answers **200 with
 * the token simply absent** when it does not recognise an id — it does not
 * error and it does not say which of the ids you asked for it dropped. So a
 * wrong id is indistinguishable from a token with no data unless you check for
 * the id you asked for in the array you got back. Every caller here does, and
 * reports a missing id as a *resolution* failure rather than as empty data.
 *
 * A symbol is not an identity either. "Moonwell" resolves to `moonwell-artemis`
 * (WELL), while `moonwell` is not a coin id at all, and a dozen dead forks
 * share a ticker with the live protocol. So a run's own resolved id, recorded
 * at research time in meta.json, always wins over anything guessed here, and a
 * guess is labelled as one all the way to the UI.
 */

const fs = require('node:fs');
const path = require('node:path');

const CG = 'https://api.coingecko.com/api/v3';
const FNG = 'https://api.alternative.me/fng';

// A quote is a "quick look" number. It may be a minute stale; it must never be
// a day stale, which would silently turn a live header into a yesterday header.
const QUOTE_TTL_MS = 90 * 1000;
const CHART_TTL_MS = 60 * 60 * 1000;      // daily candles; an hour is generous
const FNG_TTL_MS = 60 * 60 * 1000;        // the index updates once a day
const RESOLVE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a coin id is effectively permanent

const FETCH_TIMEOUT_MS = 9000;
// Nothing here is large; the cap is what stops a redirected or hostile response
// from being buffered without bound.
const MAX_BYTES = 2 * 1024 * 1024;

// CoinGecko's free tier throttles hard and answers 429. One in-flight request
// per key at a time, so a fast click-through of five tickers does not burn the
// budget on requests whose answers nobody is waiting for any more.
const inflight = new Map();

const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]{0,15}$/;
// CoinGecko ids are lowercase slugs. This is also a path segment in the disk
// cache, so it is checked rather than trusted.
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const RANGES = Object.freeze({
  '30d': { days: 30 },
  '90d': { days: 90 },
  '1y': { days: 365 },
});

const mem = new Map(); // key -> { at, value }

function resetCache() {
  mem.clear();
  inflight.clear();
}

function memGet(key, ttl) {
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  return null;
}

function memSet(key, value) {
  mem.set(key, { at: Date.now(), value });
  return value;
}

/* ------------------------------------------------------------------ disk --- */

/**
 * The disk copy is deliberately kept past its TTL: it is what the *stale* path
 * falls back to when the network is refusing. A stale number labelled stale is
 * useful; a blank header is not.
 */
function diskPath(dataDir, kind, key) {
  return path.join(dataDir, 'market', `${kind}-${key}.json`);
}

function diskRead(dataDir, kind, key) {
  try {
    const raw = fs.readFileSync(diskPath(dataDir, kind, key), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.at === 'number') return obj;
  } catch { /* absent or corrupt is a miss, not an error */ }
  return null;
}

function diskWrite(dataDir, kind, key, value) {
  try {
    const dir = path.join(dataDir, 'market');
    fs.mkdirSync(dir, { recursive: true }); // dataDir is not created for us
    const p = diskPath(dataDir, kind, key);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), value }));
    fs.renameSync(tmp, p);
  } catch { /* a cache that cannot be written is not a failed quote */ }
}

/* --------------------------------------------------------------- fetching --- */

async function getJson(url) {
  const prior = inflight.get(url);
  if (prior) return prior;

  const run = (async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: { accept: 'application/json', 'user-agent': 'clodex-crypto-research/0.1' },
      });
      if (res.status === 429) throw new Error('rate limited by CoinGecko (free tier); try again shortly');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Read with a cap rather than res.json(), so an unbounded body cannot be
      // buffered whole before we discover its size.
      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (!reader) return await res.json();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_BYTES) { try { await reader.cancel(); } catch {} throw new Error('response too large'); }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      clearTimeout(timer);
      inflight.delete(url);
    }
  })();

  inflight.set(url, run);
  return run;
}

/* ------------------------------------------------------------- resolution --- */

/**
 * symbol/name -> { id, symbol, name, guessed }.
 *
 * `guessed` is the honest part. Searching by ticker is a ranking, not an
 * identity: the top hit for a three-letter symbol is frequently a dead fork
 * with more historical volume than the live protocol. A caller that has a
 * recorded id from research time must pass it and skip this entirely.
 */
async function resolve(query, opts) {
  const q = String(query || '').trim();
  if (!q) throw new Error('nothing to resolve');
  const key = q.toLowerCase();

  const hit = memGet(`res:${key}`, RESOLVE_TTL_MS);
  if (hit) return hit;

  const disk = opts && opts.dataDir ? diskRead(opts.dataDir, 'res', encodeURIComponent(key)) : null;
  if (disk && Date.now() - disk.at < RESOLVE_TTL_MS) return memSet(`res:${key}`, disk.value);

  const data = await getJson(`${CG}/search?query=${encodeURIComponent(q)}`);
  const coins = (data && Array.isArray(data.coins)) ? data.coins : [];
  if (!coins.length) throw new Error(`CoinGecko knows no coin matching "${q}"`);

  // Prefer an exact symbol match among the top few; fall back to rank order.
  const upper = q.toUpperCase();
  const exact = coins.slice(0, 8).find((c) => String(c.symbol || '').toUpperCase() === upper);
  const pick = exact || coins[0];
  if (!pick || !ID_RE.test(String(pick.id || ''))) throw new Error(`unusable coin id for "${q}"`);

  const out = {
    id: pick.id,
    symbol: String(pick.symbol || '').toUpperCase(),
    name: pick.name || pick.id,
    guessed: true,
    alternatives: coins.slice(0, 5)
      .filter((c) => c.id !== pick.id)
      .map((c) => ({ id: c.id, symbol: String(c.symbol || '').toUpperCase(), name: c.name })),
  };
  if (opts && opts.dataDir) diskWrite(opts.dataDir, 'res', encodeURIComponent(key), out);
  return memSet(`res:${key}`, out);
}

/* ------------------------------------------------------------------ quote --- */

function pctOr(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

async function fetchQuote(id) {
  const url = `${CG}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(id)}`
    + '&price_change_percentage=7d,30d&sparkline=false';
  const arr = await getJson(url);
  if (!Array.isArray(arr)) throw new Error('unexpected response shape from CoinGecko');

  // The check this whole file exists for: a 200 with our id missing means the
  // id is wrong, NOT that the token has no data.
  const c = arr.find((x) => x && x.id === id);
  if (!c) throw new Error(`CoinGecko returned no row for id "${id}" — the id is wrong, not the data missing`);

  return {
    id: c.id,
    symbol: String(c.symbol || '').toUpperCase(),
    name: c.name || c.id,
    price: pctOr(c.current_price),
    marketCap: pctOr(c.market_cap),
    fdv: pctOr(c.fully_diluted_valuation),
    volume: pctOr(c.total_volume),
    circulating: pctOr(c.circulating_supply),
    total: pctOr(c.total_supply),
    ath: pctOr(c.ath),
    athPct: pctOr(c.ath_change_percentage),
    athDate: c.ath_date || null,
    d1: pctOr(c.price_change_percentage_24h),
    d7: pctOr(c.price_change_percentage_7d_in_currency),
    d30: pctOr(c.price_change_percentage_30d_in_currency),
    asOf: c.last_updated || null,
  };
}

async function fetchChart(id, range) {
  const spec = RANGES[range] || RANGES['30d'];
  const url = `${CG}/coins/${encodeURIComponent(id)}/market_chart`
    + `?vs_currency=usd&days=${spec.days}&interval=daily`;
  const data = await getJson(url);
  const prices = (data && Array.isArray(data.prices)) ? data.prices : [];
  return prices
    .filter((p) => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number')
    .map((p) => ({ t: p[0], v: p[1] }));
}

async function fetchFng() {
  const data = await getJson(`${FNG}/?limit=31`);
  const rows = (data && Array.isArray(data.data)) ? data.data : [];
  if (!rows.length) return null;
  const now = rows[0];
  const then = rows[rows.length - 1];
  const n = (r) => (r && r.value != null ? Number(r.value) : null);
  return {
    value: n(now),
    label: (now && now.value_classification) || null,
    ago: n(then),
    agoDays: rows.length - 1,
  };
}

/**
 * The one entry point the engine calls.
 *
 * Returns a RESULT, never throws — an unreachable quote source is an expected
 * condition in this plugin, not an exception. Three outcomes, kept distinct,
 * because a source that is refusing must not look like a source that is empty:
 *
 *   { state: 'live'   , quote, chart, fng }
 *   { state: 'stale'  , quote, chart, fng, error, cachedAt }   disk copy, past TTL
 *   { state: 'failed' , error }                                 nothing to show
 */
async function quote(opts) {
  const { dataDir, range } = opts || {};
  const rangeKey = RANGES[range] ? range : '30d';

  let ident;
  try {
    if (opts.id && ID_RE.test(opts.id)) {
      ident = { id: opts.id, symbol: opts.symbol || '', name: opts.name || opts.id, guessed: false };
    } else if (opts.symbol && SYMBOL_RE.test(opts.symbol)) {
      ident = await resolve(opts.symbol, { dataDir });
    } else {
      return { state: 'failed', error: 'no usable coin id or symbol' };
    }
  } catch (e) {
    return { state: 'failed', error: `could not resolve an id: ${e.message}` };
  }

  // The cache holds MARKET DATA ONLY, keyed by coin id and range. Identity is
  // deliberately kept out of it and re-attached per call: two callers can reach
  // the same coin by different routes — one with an id recorded at research
  // time, one by guessing from a ticker — and caching `ident` alongside the
  // numbers would let the first caller's `guessed: false` be served to the
  // second. The "id guessed" warning would then vanish depending on what
  // someone had clicked earlier, which is exactly when it matters most.
  const memKey = `q:${ident.id}:${rangeKey}`;
  const identOut = { ...ident };

  const fresh = memGet(memKey, QUOTE_TTL_MS);
  if (fresh) {
    return {
      ...fresh,
      ident: { ...identOut, symbol: identOut.symbol || fresh.quote.symbol, name: identOut.name || fresh.quote.name },
    };
  }

  try {
    // Fear & Greed is market-wide context; its failure must not fail the quote.
    const [q, chart, fng] = await Promise.all([
      fetchQuote(ident.id),
      fetchChart(ident.id, rangeKey).catch(() => []),
      fetchFng().catch(() => null),
    ]);
    const payload = { state: 'live', quote: q, chart, range: rangeKey, fng };
    memSet(memKey, payload);
    if (dataDir) diskWrite(dataDir, 'q', `${ident.id}-${rangeKey}`, payload);
    return { ...payload, ident: { ...identOut, symbol: identOut.symbol || q.symbol, name: identOut.name || q.name } };
  } catch (e) {
    // Past-TTL disk copy, on purpose. Labelled stale so the UI can say so.
    const disk = dataDir ? diskRead(dataDir, 'q', `${ident.id}-${rangeKey}`) : null;
    if (disk && disk.value) {
      return { ...disk.value, state: 'stale', error: e.message, cachedAt: disk.at, ident: identOut };
    }
    return { state: 'failed', error: e.message, ident: identOut };
  }
}

module.exports = { quote, resolve, resetCache, RANGES, SYMBOL_RE, ID_RE };
