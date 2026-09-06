'use strict';

/**
 * market.js — the quote half of stock-assessments. Required by engine.js only;
 * it never touches the renderer, and it holds no state that outlives a call
 * beyond an in-process memory cache the engine resets on activate().
 *
 * Two public sources, both keyless, deliberately kept separate:
 *
 *   Yahoo v8 chart   price, day range, 52-week range, volume, the daily series
 *                    behind the sparkline. Undocumented and unversioned in
 *                    practice — treat every field as optional.
 *   SEC XBRL         shares outstanding, from which market cap is derived.
 *                    Optional: it needs a contact email in the User-Agent per
 *                    the SEC's fair-access policy, so it stays off until the
 *                    operator supplies one in settings.
 *
 * What is NOT here, on purpose: P/E and dividend yield. Yahoo's v7 quote
 * endpoint that used to carry them now answers Unauthorized, and deriving a
 * trailing P/E from XBRL quarterly EPS tags gave 20.1 against a real 18.3 for
 * NKE — fiscal-year misalignment and gaps in the tags. A confidently wrong
 * multiple in a research tool is worse than a missing one, so the field is
 * absent rather than approximate.
 */

const fs = require('node:fs');
const path = require('node:path');

const CHART_HOST = 'https://query1.finance.yahoo.com';
const SEC_DATA = 'https://data.sec.gov';
const SEC_WWW = 'https://www.sec.gov';

// A quote is a "quick look" number, so it may be a minute stale, but it must
// never be a day stale — that would silently turn a live header into a
// yesterday header. Shares outstanding move on filings, so a day is generous.
const QUOTE_TTL_MS = 90 * 1000;
const SHARES_TTL_MS = 24 * 60 * 60 * 1000;
const CIK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 8000;
// The CIK map is ~800 KB; everything else is a few KB. The cap is what stops a
// redirected or hostile response from being buffered without bound.
const MAX_BYTES = 4 * 1024 * 1024;

// Yahoo rejects an unknown range with a 422 rather than clamping, so the set is
// closed here and the renderer can only ask for one of these.
const RANGES = Object.freeze({
  '1mo': { range: '1mo', interval: '1d' },
  '6mo': { range: '6mo', interval: '1d' },
  '1y': { range: '1y', interval: '1d' },
});

// Same grammar the engine uses for a directory segment: a ticker reaches this
// file from the renderer, and it is interpolated into a URL and a filename.
const TICKER_RE = /^[A-Z0-9][A-Z0-9.-]{0,15}$/;

const mem = new Map(); // `${ticker}:${range}` -> { at, quote }

function resetCache() {
  mem.clear();
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * One JSON GET with a hard timeout and a size cap.
 *
 * Throws on anything that is not a 200 with parseable JSON. Callers turn that
 * into a result rather than letting it escape — an unreachable quote endpoint
 * is an expected condition for this plugin, not an exception.
 */
async function getJson(url, userAgent) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
    headers: {
      // Yahoo serves a consent interstitial to a client that sends no UA.
      'User-Agent': userAgent,
      Accept: 'application/json,text/plain,*/*',
    },
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('response too large');
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('response too large');
  return JSON.parse(text);
}

// The default identifies the plugin without identifying the operator. The SEC
// path substitutes a contact address the operator entered themselves; Yahoo
// never sees one.
const YAHOO_UA = 'Mozilla/5.0 (compatible; clodex-stock-assessments/0.3)';

// ---------------------------------------------------------------------------
// Disk cache — dataDir/market/
// ---------------------------------------------------------------------------

function cacheDir(dataDir) {
  return path.join(dataDir, 'market');
}

/** Atomic write, so a crash mid-write cannot leave a truncated cache file. */
function writeCache(dataDir, name, value) {
  const dir = cacheDir(dataDir);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, name);
    const tmp = path.join(dir, `.${name}.tmp.${process.pid}.${Date.now()}`);
    let fd;
    try {
      fd = fs.openSync(tmp, 'w', 0o600);
      fs.writeSync(fd, JSON.stringify({ at: Date.now(), value }));
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* closing */ } }
    }
    fs.renameSync(tmp, file);
  } catch (_) {
    // A cache that cannot be written is a slower plugin, not a broken one.
  }
}

/**
 * Read a cache entry. `maxAgeMs` of 0 means "any age" — that is how a failed
 * fetch falls back to the last good value and labels it stale, which is the
 * whole reason the disk copy exists alongside the memory one.
 */
function readCache(dataDir, name, maxAgeMs) {
  try {
    const raw = fs.readFileSync(path.join(cacheDir(dataDir), name), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.at !== 'number') return null;
    if (maxAgeMs && Date.now() - parsed.at > maxAgeMs) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shares outstanding → market cap (SEC, opt-in)
// ---------------------------------------------------------------------------

async function cikFor(dataDir, ticker, ua) {
  const cached = readCache(dataDir, 'cik-map.json', CIK_TTL_MS);
  let map = cached && cached.value;
  if (!map) {
    const raw = await getJson(`${SEC_WWW}/files/company_tickers.json`, ua);
    map = {};
    for (const k of Object.keys(raw || {})) {
      const row = raw[k];
      if (row && row.ticker && row.cik_str) map[String(row.ticker).toUpperCase()] = row.cik_str;
    }
    writeCache(dataDir, 'cik-map.json', map);
  }
  const cik = map[ticker];
  return cik ? String(cik).padStart(10, '0') : null;
}

function latestFact(json) {
  const units = json && json.units;
  if (!units) return null;
  let best = null;
  for (const arr of Object.values(units)) {
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      if (!row || typeof row.val !== 'number' || !row.filed) continue;
      if (!best || row.filed > best.filed) best = row;
    }
  }
  return best;
}

/**
 * Shares outstanding, preferring whichever tag was filed most recently.
 *
 * Both tags are queried because neither is reliable alone: NKE's cover-page
 * `dei` value was last filed in 2015 and is off by 40%, while the `us-gaap`
 * weighted diluted count is current. Taking the later filing rather than a
 * fixed preference order is what makes this correct for both shapes.
 */
async function sharesOutstanding(dataDir, ticker, secContact) {
  const name = `shares-${ticker}.json`;
  const fresh = readCache(dataDir, name, SHARES_TTL_MS);
  if (fresh) return fresh.value;

  const ua = `clodex-stock-assessments/0.3 (${secContact})`;
  const cik = await cikFor(dataDir, ticker, ua);
  if (!cik) return null;

  const tags = [
    'us-gaap/WeightedAverageNumberOfDilutedSharesOutstanding',
    'dei/EntityCommonStockSharesOutstanding',
  ];
  let best = null;
  for (const tag of tags) {
    try {
      const json = await getJson(`${SEC_DATA}/api/xbrl/companyconcept/CIK${cik}/${tag}.json`, ua);
      const row = latestFact(json);
      if (row && (!best || row.filed > best.filed)) best = row;
    } catch (_) {
      // One missing tag is normal; a company need not report both.
    }
  }
  if (!best) return null;
  const value = { shares: best.val, asOf: best.end, filed: best.filed };
  writeCache(dataDir, name, value);
  return value;
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function shapeQuote(ticker, range, json) {
  const result = json && json.chart && Array.isArray(json.chart.result)
    ? json.chart.result[0]
    : null;
  const meta = result && result.meta;
  if (!meta) throw new Error('no quote in the response');

  const price = num(meta.regularMarketPrice);

  // The series is parallel arrays with nulls at holidays and halts; both must
  // be dropped together or the sparkline shears against its own time axis.
  const stamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = result.indicators
    && Array.isArray(result.indicators.quote)
    && result.indicators.quote[0]
    && Array.isArray(result.indicators.quote[0].close)
    ? result.indicators.quote[0].close
    : [];
  const series = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const c = num(closes[i]);
    if (c === null || typeof stamps[i] !== 'number') continue;
    series.push({ t: stamps[i] * 1000, c });
  }

  /*
   * Previous close, and the one trap in this endpoint worth a comment.
   *
   * `meta.chartPreviousClose` is the close before the REQUESTED WINDOW, not
   * yesterday: on a 1mo range it is a month old, which rendered NKE's −0.95%
   * day as −7.54%. The second-to-last point of the daily series is the real
   * previous close, whether the last point is today's partial bar or the last
   * completed session. Meta stays as the fallback for a one-point series.
   */
  const prev = series.length >= 2
    ? series[series.length - 2].c
    : (num(meta.chartPreviousClose) ?? num(meta.previousClose));
  const change = price !== null && prev !== null ? price - prev : null;

  return {
    ticker,
    range,
    name: typeof meta.longName === 'string' ? meta.longName : (typeof meta.shortName === 'string' ? meta.shortName : ''),
    exchange: typeof meta.fullExchangeName === 'string' ? meta.fullExchangeName : '',
    currency: typeof meta.currency === 'string' ? meta.currency : 'USD',
    price,
    prevClose: prev,
    change,
    changePct: change !== null && prev ? (change / prev) * 100 : null,
    dayLow: num(meta.regularMarketDayLow),
    dayHigh: num(meta.regularMarketDayHigh),
    low52: num(meta.fiftyTwoWeekLow),
    high52: num(meta.fiftyTwoWeekHigh),
    volume: num(meta.regularMarketVolume),
    marketTime: num(meta.regularMarketTime) ? meta.regularMarketTime * 1000 : null,
    series,
    marketCap: null,
    sharesAsOf: null,
  };
}

/**
 * A quote for `ticker` over `range`.
 *
 * Three outcomes, kept distinct on purpose — the x-lookup post-mortem in this
 * workspace turned on exactly this: a source that is refusing must never render
 * as a source that is empty.
 *
 *   { ok: true,  stale: false }  live
 *   { ok: true,  stale: true  }  the fetch failed, this is the last good copy
 *   { ok: false, error }         nothing to show, and why
 */
async function quote({ dataDir, ticker, range, secContact, log }) {
  if (typeof ticker !== 'string' || !TICKER_RE.test(ticker)) {
    return { ok: false, error: 'not a ticker' };
  }
  const spec = RANGES[range] ? range : '1mo';
  const key = `${ticker}:${spec}`;
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < QUOTE_TTL_MS) {
    return { ok: true, stale: false, asOf: hit.at, quote: hit.quote };
  }

  const cacheName = `quote-${ticker}-${spec}.json`;
  let q = null;
  try {
    const { range: r, interval } = RANGES[spec];
    const url = `${CHART_HOST}/v8/finance/chart/${encodeURIComponent(ticker)}`
      + `?range=${r}&interval=${interval}`;
    q = shapeQuote(ticker, spec, await getJson(url, YAHOO_UA));
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (log) log.info(`quote ${ticker} failed: ${msg}`);
    const last = readCache(dataDir, cacheName, 0);
    if (last && last.value) {
      return { ok: true, stale: true, asOf: last.at, quote: last.value, error: msg };
    }
    return {
      ok: false,
      error: /HTTP 4/.test(msg)
        ? `the quote source refused the request (${msg})`
        : `could not reach the quote source — ${msg}`,
    };
  }

  // Market cap is strictly additive: the SEC leg failing leaves a quote with a
  // blank cap, never an error, because the operator may not have opted in.
  if (secContact) {
    try {
      const s = await sharesOutstanding(dataDir, ticker, secContact);
      if (s && s.shares && q.price !== null) {
        q.marketCap = s.shares * q.price;
        q.sharesAsOf = s.asOf;
      }
    } catch (e) {
      if (log) log.info(`shares ${ticker} failed: ${String((e && e.message) || e)}`);
    }
  }

  const at = Date.now();
  mem.set(key, { at, quote: q });
  writeCache(dataDir, cacheName, q);
  return { ok: true, stale: false, asOf: at, quote: q };
}

module.exports = { quote, resetCache, RANGES };
