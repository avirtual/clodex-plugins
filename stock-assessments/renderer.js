'use strict';

/**
 * stock-assessments — renderer half. One activation per window; all state lives
 * in this closure.
 *
 * Three panes, matching the shape of the data on disk: tickers → dated runs →
 * one document. Nothing is fetched until the overlay opens and every open
 * re-reads, so the freshness bound is "as of open" and there is no cache to go
 * stale behind a research run that just wrote a new folder.
 *
 * Read-only throughout. Assessments are point-in-time documents; the one thing
 * this surface can change is which folder it reads.
 */

// The command the re-assess control describes. The engine builds the line it
// actually injects; this is only what the operator is shown, and the two must
// agree — see engine.js for why it is namespaced.
const RESEARCH_CMD = '/stock-assessments:stock-research';

// --- markdown -------------------------------------------------------------
//
// A deliberately small block renderer, built as DOM nodes rather than HTML
// text. Two reasons it is not a library and not innerHTML: a plugin cannot pull
// dependencies, and these documents are model-written prose that may contain
// anything at all — every leaf below is set through textContent, so a document
// cannot inject markup into the window it is displayed in.
//
// It handles what this corpus actually uses: ATX headings, bullet lists, pipe
// tables, blockquotes, fenced code, and inline bold/italic/code/links.

function inlineInto(parent, text) {
  // One pass, alternation ordered longest-first so `**` wins over `*`.
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]*\)|\*[^*\n]+\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('**')) {
      const b = document.createElement('strong');
      b.textContent = tok.slice(2, -2);
      parent.appendChild(b);
    } else if (tok.startsWith('`')) {
      const c = document.createElement('code');
      c.className = 'sa-code';
      c.textContent = tok.slice(1, -1);
      parent.appendChild(c);
    } else if (tok.startsWith('[')) {
      // Rendered as a titled span, never an anchor: a link in a research doc
      // points at a source the operator may want to see, but a plugin overlay
      // is not a browser and an <a> here would either do nothing or navigate
      // the app window out from under them.
      const close = tok.indexOf('](');
      const s = document.createElement('span');
      s.className = 'sa-link';
      s.textContent = tok.slice(1, close);
      s.title = tok.slice(close + 2, -1);
      parent.appendChild(s);
    } else {
      const i = document.createElement('em');
      i.textContent = tok.slice(1, -1);
      parent.appendChild(i);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

const isTableSep = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes('-');

function renderMarkdown(text) {
  const root = document.createElement('div');
  root.className = 'sa-md';
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');

  let i = 0;
  let para = null;
  const flushPara = () => {
    if (para) { root.appendChild(para); para = null; }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { flushPara(); i += 1; continue; }

    // fenced code
    if (/^\s*```/.test(line)) {
      flushPara();
      i += 1;
      const buf = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1; // closing fence, or end of file
      const pre = document.createElement('pre');
      pre.className = 'sa-pre';
      pre.textContent = buf.join('\n');
      root.appendChild(pre);
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const el = document.createElement(`h${Math.min(h[1].length + 1, 6)}`);
      el.className = `sa-h sa-h${h[1].length}`;
      inlineInto(el, h[2].trim());
      root.appendChild(el);
      i += 1;
      continue;
    }

    // horizontal rule — checked before the table sniff, which a `---` line
    // would otherwise satisfy on its own
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      root.appendChild(document.createElement('hr'));
      i += 1;
      continue;
    }

    // table: a pipe row followed by a separator row
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const table = document.createElement('table');
      table.className = 'sa-table';
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      for (const c of splitRow(line)) {
        const th = document.createElement('th');
        inlineInto(th, c);
        hr.appendChild(th);
      }
      thead.appendChild(hr);
      table.appendChild(thead);
      i += 2;
      const tbody = document.createElement('tbody');
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const tr = document.createElement('tr');
        for (const c of splitRow(lines[i])) {
          const td = document.createElement('td');
          inlineInto(td, c);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
        i += 1;
      }
      table.appendChild(tbody);
      root.appendChild(table);
      continue;
    }

    // list — bullets and ordered, flat. Continuation lines are folded into the
    // item they belong to, because this corpus hard-wraps its prose at ~68
    // columns and treating each wrapped line as its own bullet would shred it.
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushPara();
      const ordered = /^\s*\d+\./.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      list.className = 'sa-list';
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '');
        i += 1;
        while (
          i < lines.length
          && lines[i].trim()
          && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])
          && !/^#{1,6}\s/.test(lines[i])
          && !/^\s*```/.test(lines[i])
        ) {
          item += ` ${lines[i].trim()}`;
          i += 1;
        }
        const li = document.createElement('li');
        inlineInto(li, item);
        list.appendChild(li);
      }
      root.appendChild(list);
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      const bq = document.createElement('blockquote');
      bq.className = 'sa-quote';
      inlineInto(bq, buf.join(' '));
      root.appendChild(bq);
      continue;
    }

    // paragraph, wrapped lines joined
    if (!para) {
      para = document.createElement('p');
      para.className = 'sa-p';
      inlineInto(para, line.trim());
    } else {
      para.appendChild(document.createTextNode(' '));
      inlineInto(para, line.trim());
    }
    i += 1;
  }
  flushPara();
  return root;
}

module.exports.renderMarkdown = renderMarkdown;

// --- helpers --------------------------------------------------------------

function scoreClass(n) {
  if (!Number.isFinite(n)) return 'sa-score sa-score-none';
  if (n >= 60) return 'sa-score sa-score-hi';
  if (n >= 45) return 'sa-score sa-score-mid';
  return 'sa-score sa-score-lo';
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

function fmtAgo(ms) {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/**
 * The text the operator decides on before an expensive run starts.
 *
 * It names the exact line to be typed and the session that receives it, because
 * that is the whole decision: this is the one control here that spends money
 * and time rather than displaying something already paid for.
 */
function confirmRerunText(ticker, sessionName, stale) {
  const out = [`Run ${RESEARCH_CMD} ${ticker} in “${sessionName}”?`, ''];
  if (stale && stale.reasons && stale.reasons.length) {
    out.push('Why it looks due:');
    for (const r of stale.reasons) out.push(`  · ${r}`);
    out.push('');
  }
  out.push('This starts a full research run — several subagents and a lot of');
  out.push('web research — and writes a new dated assessment folder.');
  out.push('');
  out.push('It is typed into that session as if you had typed it, so it lands');
  out.push('with the agent’s next turn if it is busy.');
  return out.join('\n');
}

module.exports.confirmRerunText = confirmRerunText;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  // textContent, never innerHTML: tickers, titles and document text are all
  // file content.
  if (text !== undefined) e.textContent = text;
  return e;
}

// --- quote header ----------------------------------------------------------

const QUOTE_RANGES = [['1mo', '1M'], ['6mo', '6M'], ['1y', '1Y']];
const SVG_NS = 'http://www.w3.org/2000/svg';

function fmtMoney(n, currency) {
  if (!Number.isFinite(n)) return '—';
  const s = n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency && currency !== 'USD' ? `${s} ${currency}` : s;
}

function fmtCompact(n) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const [div, suffix] = abs >= 1e12 ? [1e12, 'T']
    : abs >= 1e9 ? [1e9, 'B']
      : abs >= 1e6 ? [1e6, 'M']
        : abs >= 1e3 ? [1e3, 'K'] : [1, ''];
  return `${(n / div).toFixed(abs >= 1e3 ? 2 : 0)}${suffix}`;
}

function fmtClock(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch (_) {
    return '';
  }
}

function fmtDay(ms) {
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
  } catch (_) {
    return '';
  }
}

/**
 * The price chart.
 *
 * A bare sparkline is only a shape: scaled to its own min and max, a 76%
 * decline and a flat month draw identically. So this labels its own vertical
 * extent, marks where the period opened, and reads out date and price under
 * the cursor.
 *
 * Geometry note: the plot is drawn in a 0..100 × 0..32 viewBox with
 * preserveAspectRatio="none", so it stretches to any pane width — which means
 * anything that must NOT stretch (text, stroke widths) cannot live inside it.
 * The labels are HTML positioned over the SVG, and strokes use
 * vector-effect: non-scaling-stroke.
 */
function priceChart(series, up, currency) {
  const wrap = el('div', 'sa-chart');
  // The plot is its own positioning box: the date row below it is part of the
  // wrapper, so a marker positioned as a percentage of the WRAPPER would sit
  // low by exactly the height of that row.
  const plot = el('div', 'sa-chart-plot');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'sa-spark');
  svg.setAttribute('viewBox', '0 0 100 32');
  svg.setAttribute('preserveAspectRatio', 'none');
  plot.appendChild(svg);
  wrap.appendChild(plot);
  if (!Array.isArray(series) || series.length < 2) return wrap;

  let lo = Infinity;
  let hi = -Infinity;
  for (const p of series) {
    if (p.c < lo) lo = p.c;
    if (p.c > hi) hi = p.c;
  }
  // A flat series would divide by zero; give it a hairline band instead.
  const span = hi - lo || Math.abs(hi) || 1;
  const step = 100 / (series.length - 1);
  const yOf = (c) => 30 - ((c - lo) / span) * 28;
  const pts = series.map((p, i) => `${(i * step).toFixed(2)},${yOf(p.c).toFixed(2)}`);

  // Where the period opened: the reference the whole line should be read
  // against, and the one number that says whether this shape is a gain.
  const openY = yOf(series[0].c);
  const base = document.createElementNS(SVG_NS, 'line');
  base.setAttribute('class', 'sa-spark-base');
  base.setAttribute('x1', '0');
  base.setAttribute('x2', '100');
  base.setAttribute('y1', openY.toFixed(2));
  base.setAttribute('y2', openY.toFixed(2));
  svg.appendChild(base);

  const fill = document.createElementNS(SVG_NS, 'polygon');
  fill.setAttribute('class', up ? 'sa-spark-fill sa-up' : 'sa-spark-fill sa-down');
  fill.setAttribute('points', `0,32 ${pts.join(' ')} 100,32`);
  svg.appendChild(fill);

  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('class', up ? 'sa-spark-line sa-up' : 'sa-spark-line sa-down');
  line.setAttribute('points', pts.join(' '));
  svg.appendChild(line);

  const cursor = document.createElementNS(SVG_NS, 'line');
  cursor.setAttribute('class', 'sa-spark-cursor');
  cursor.setAttribute('y1', '0');
  cursor.setAttribute('y2', '32');
  cursor.style.display = 'none';
  svg.appendChild(cursor);

  // Axis labels, in HTML so they keep their aspect and their font size.
  const hiLab = el('span', 'sa-chart-hi', fmtMoney(hi, ''));
  const loLab = el('span', 'sa-chart-lo', fmtMoney(lo, ''));
  plot.appendChild(hiLab);
  plot.appendChild(loLab);

  const openLab = el('span', 'sa-chart-open', `open ${fmtMoney(series[0].c, '')}`);
  openLab.style.top = `${((openY / 32) * 100).toFixed(1)}%`;
  plot.appendChild(openLab);

  const dates = el('div', 'sa-chart-dates');
  dates.appendChild(el('span', null, fmtDay(series[0].t)));
  dates.appendChild(el('span', null, fmtDay(series[series.length - 1].t)));
  wrap.appendChild(dates);

  // Readout: date, price, and the move from the period open — the number the
  // range buttons are actually being used to ask for.
  const read = el('div', 'sa-chart-read');
  plot.appendChild(read);

  const dot = el('div', 'sa-chart-dot');
  dot.style.display = 'none';
  plot.appendChild(dot);

  const at = (ev) => {
    const r = plot.getBoundingClientRect();
    if (!r.width) return;
    const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    const i = Math.max(0, Math.min(series.length - 1, Math.round(f * (series.length - 1))));
    const p = series[i];
    const pct = series[0].c ? ((p.c - series[0].c) / series[0].c) * 100 : 0;
    const sign = pct >= 0 ? '+' : '−';

    while (read.firstChild) read.removeChild(read.firstChild);
    read.appendChild(el('span', 'sa-chart-readd', fmtDay(p.t)));
    read.appendChild(el('span', 'sa-chart-readp', fmtMoney(p.c, currency)));
    read.appendChild(el('span', pct >= 0 ? 'sa-chart-readc sa-up' : 'sa-chart-readc sa-down',
      `${sign}${Math.abs(pct).toFixed(1)}%`));
    read.classList.add('sa-on');

    const x = (i * step);
    cursor.setAttribute('x1', x.toFixed(2));
    cursor.setAttribute('x2', x.toFixed(2));
    cursor.style.display = '';
    dot.style.display = '';
    dot.style.left = `${x.toFixed(2)}%`;
    dot.style.top = `${((yOf(p.c) / 32) * 100).toFixed(2)}%`;
  };

  wrap.addEventListener('mousemove', at);
  wrap.addEventListener('mouseleave', () => {
    while (read.firstChild) read.removeChild(read.firstChild);
    read.classList.remove('sa-on');
    cursor.style.display = 'none';
    dot.style.display = 'none';
  });

  return wrap;
}

/** The 52-week track, with a marker showing where the current price sits. */
function rangeBar(q) {
  const wrap = el('div', 'sa-52');
  if (!Number.isFinite(q.low52) || !Number.isFinite(q.high52) || !Number.isFinite(q.price)) {
    return wrap;
  }
  wrap.appendChild(el('span', 'sa-52end', fmtMoney(q.low52, '')));
  const track = el('div', 'sa-52track');
  const span = q.high52 - q.low52;
  const pct = span > 0 ? ((q.price - q.low52) / span) * 100 : 50;
  const dot = el('div', 'sa-52dot');
  dot.style.left = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
  dot.title = `${fmtMoney(q.price, q.currency)} — ${pct.toFixed(0)}% of the 52-week range`;
  track.appendChild(dot);
  wrap.appendChild(track);
  wrap.appendChild(el('span', 'sa-52end', fmtMoney(q.high52, '')));
  return wrap;
}

module.exports.activate = (rhost) => {
  // Named capability checks, same reasoning as the engine half: `hostApi` is
  // "1" on every host that will ever run this, so the manifest cannot express
  // which of these exist. A missing one throws here with a readable message
  // rather than a TypeError from inside a click handler.
  if (!rhost || !rhost.ui || !rhost.ui.surfaces || typeof rhost.ui.surfaces.overlay !== 'function') {
    throw new Error('this host has no rhost.ui.surfaces.overlay; a newer Clodex is needed for the viewer');
  }
  if (!rhost.ui.sidebar || typeof rhost.ui.sidebar.footerButton !== 'function') {
    throw new Error('this host has no rhost.ui.sidebar.footerButton; a newer Clodex is needed to open the viewer');
  }
  if (!rhost.ui.settings || typeof rhost.ui.settings.section !== 'function') {
    throw new Error('this host has no rhost.ui.settings.section; a newer Clodex is needed for the folder setting');
  }
  if (typeof rhost.invoke !== 'function') {
    throw new Error('this host has no rhost.invoke; a newer Clodex is needed to reach the engine half');
  }
  if (!rhost.sessions || typeof rhost.sessions.active !== 'function') {
    throw new Error('this host has no rhost.sessions.active; a newer Clodex is needed to find the workspace');
  }

  let torn = false;
  const alive = () => !torn;

  let refresh = null; // assigned by mount; the host always mounts before onOpen

  const surface = rhost.ui.surfaces.overlay({
    id: 'main',
    mount(rootEl) { refresh = wire(rootEl); },
    onOpen() { if (refresh) refresh(); },
  });

  function wire(rootEl) {
    rootEl.innerHTML = '';

    const modal = el('div', 'sa-modal');

    const topbar = el('div', 'sa-topbar');
    topbar.appendChild(el('div', 'sa-title', 'Stock Assessments'));
    const rootLabel = el('div', 'sa-rootlabel', '');
    topbar.appendChild(rootLabel);

    const revealBtn = el('button', 'sa-btn', 'Reveal');
    revealBtn.title = 'Show this run’s folder in Finder';
    const folderBtn = el('button', 'sa-btn', 'Folder…');
    folderBtn.title = 'Choose the workspace folder to read assessments from';
    const closeBtn = el('button', 'sa-close', '×');
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => surface.close());
    topbar.appendChild(revealBtn);
    topbar.appendChild(folderBtn);
    topbar.appendChild(closeBtn);

    const body = el('div', 'sa-body');
    const tickerPane = el('div', 'sa-tickers');
    const runPane = el('div', 'sa-runs');

    // The document pane holds two children that persist for the life of the
    // overlay: the quote header, and the document itself. Only the second is
    // rebuilt per document — a header that repainted on every click would
    // flicker, and would refetch on a click that changed nothing about it.
    const docPane = el('div', 'sa-doc');
    const quoteHost = el('div', 'sa-quotehost');
    const docInner = el('div', 'sa-docinner');
    docPane.appendChild(quoteHost);
    docPane.appendChild(docInner);
    body.appendChild(tickerPane);
    body.appendChild(runPane);
    body.appendChild(docPane);

    modal.appendChild(topbar);
    modal.appendChild(body);
    rootEl.appendChild(modal);

    // State. `index` is the last successful listing; the three selections are
    // names, re-resolved against `index` on every render so a vanished folder
    // cannot leave a dangling object behind.
    let index = [];
    let selTicker = null;
    let selDate = null;
    let selFile = null;
    let selDir = null;      // the run folder on disk, for Reveal
    let runner = null;      // whether this window's session can run research
    let requests = {};      // ticker -> ms of the last re-run request
    let quoteRange = '1mo';  // sticky across tickers, per window
    let indexSeq = 0;
    let docSeq = 0;

    // The session this window is showing. Read per fetch, not captured: the
    // user switches sessions with the overlay closed, and the next open should
    // follow them.
    const sessionName = () => rhost.sessions.active();

    revealBtn.addEventListener('click', () => {
      // selDir comes from the engine's own directory walk, never assembled
      // here, so Reveal can only ever open a folder that was actually listed.
      if (!selDir) return;
      // Checked at the point of use rather than at activation: an older host
      // missing this should lose one button, not the whole viewer.
      if (typeof rhost.ui.openPath !== 'function') {
        rhost.log.error('this host has no rhost.ui.openPath; Reveal is unavailable');
        return;
      }
      rhost.ui.openPath(selDir);
    });

    folderBtn.addEventListener('click', () => {
      chooseFolder().catch((e) => rhost.log.error('folder pick failed', e));
    });

    async function chooseFolder() {
      if (typeof rhost.ui.pickDirectory !== 'function') {
        rhost.log.error('this host has no rhost.ui.pickDirectory; set the folder in settings instead');
        return;
      }
      const dir = await rhost.ui.pickDirectory();
      if (!alive() || !dir) return;
      let res;
      try {
        res = await rhost.invoke('setRoot', dir);
      } catch (e) {
        rhost.log.error('setRoot failed', e);
        res = null;
      }
      if (!alive()) return;
      if (!res || res.ok !== true) {
        rhost.ui.showToast((res && res.error) || 'Could not use that folder', { kind: 'error' });
        return;
      }
      // A new root invalidates every selection — the same ticker in a different
      // library is a different document.
      selTicker = null;
      selDate = null;
      selFile = null;
      await reload();
    }

    // --- document pane ---

    async function showDoc(ticker, date, file) {
      const my = ++docSeq;
      selFile = file;
      markDocSelection();
      docInner.innerHTML = '';
      docInner.appendChild(el('div', 'sa-empty', 'Loading…'));

      let res;
      try {
        res = await rhost.invoke('doc', { sessionName: sessionName(), ticker, date, file });
      } catch (e) {
        rhost.log.error('doc fetch failed', e);
        res = null;
      }
      // A monotonic token, not an identity check: clicking the same document
      // twice while the first read is in flight is reachable, and the slower
      // reply must not repaint over the faster one.
      if (!alive() || my !== docSeq) return;

      docInner.innerHTML = '';
      if (!res || res.ok !== true) {
        docInner.appendChild(el('div', 'sa-empty', `Could not read ${file}: ${(res && res.error) || 'unknown error'}`));
        return;
      }
      const head = el('div', 'sa-docbar');
      head.appendChild(el('span', 'sa-docname', `${ticker} / ${date} / ${file}`));
      docInner.appendChild(head);
      const scroll = el('div', 'sa-docscroll');
      scroll.appendChild(renderMarkdown(res.text));
      docInner.appendChild(scroll);
      scroll.scrollTop = 0;
    }

    function markDocSelection() {
      for (const b of runPane.querySelectorAll('.sa-docbtn')) {
        b.classList.toggle('sa-selected', b.dataset.saFile === selFile && b.dataset.saDate === selDate);
      }
    }

    // --- re-run ---

    /**
     * The re-run control, in one of three states.
     *
     * A cooldown REPLACES the button rather than disabling it. inject cannot
     * confirm delivery, so after a click there is nothing observable to say the
     * request landed — a still-clickable button invites a second expensive run,
     * and a greyed one says "wait" without saying what for.
     */
    function buildRerun(t) {
      const wrap = el('div', 'sa-rerun');
      const last = requests[t.ticker];

      if (Number.isFinite(last)) {
        const note = el('div', 'sa-rerun-sent', `↻ requested ${fmtAgo(last)}`);
        note.title = `${RESEARCH_CMD} ${t.ticker} was typed into a session ${fmtAgo(last)}.\n`
          + 'Clodex cannot confirm an injected line was received, so this is a record of the request, not of the run.';
        wrap.appendChild(note);
        return wrap;
      }

      if (!runner || runner.ok !== true) {
        // Explained, not hidden: a missing button with no reason reads as a
        // broken plugin, and the reason is usually one the operator can fix by
        // clicking a different session.
        const off = el('div', 'sa-rerun-off', '↻ re-run unavailable');
        off.title = (runner && runner.reason)
          ? `${runner.reason}. Open this from a Claude session in this workspace to re-run research.`
          : 'Open this from a Claude session in this workspace to re-run research.';
        wrap.appendChild(off);
        return wrap;
      }

      const btn = el('button', 'sa-rerun-btn', `↻ Re-assess ${t.ticker}`);
      if (t.stale && t.stale.reasons && t.stale.reasons.length) {
        btn.classList.add('sa-rerun-due');
      }
      btn.title = `Type ${RESEARCH_CMD} ${t.ticker} into “${runner.name}”`;
      btn.addEventListener('click', () => {
        doRerun(t, btn).catch((e) => rhost.log.error('rerun failed', e));
      });
      wrap.appendChild(btn);
      return wrap;
    }

    async function doRerun(t, btn) {
      // Re-entrancy guard: two dialogs from a double-click would mean two runs.
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        if (!confirm(confirmRerunText(t.ticker, runner.name, t.stale))) return;
        let res;
        try {
          res = await rhost.invoke('rerun', { sessionName: sessionName(), ticker: t.ticker });
        } catch (e) {
          rhost.log.error('rerun invoke failed', e);
          res = null;
        }
        if (!alive()) return;
        if (!res || res.ok !== true) {
          rhost.ui.showToast((res && res.error) || 'Could not start the research run', { kind: 'error' });
          // A refusal may carry fresher cooldown state than this window has —
          // another window firing the same ticker is exactly how that happens.
          if (res && res.requests) {
            requests = res.requests;
            renderRuns();
          }
          return;
        }
        requests = res.requests || requests;
        // "Sent to", not "started": all that is known is that inject was called.
        rhost.ui.showToast(`Sent “${res.command}” to ${res.session}`, { kind: 'info' });
        renderRuns();
      } finally {
        if (alive() && btn.isConnected) btn.disabled = false;
      }
    }

    // --- run pane ---

    /**
     * Paint the quote box for `ticker` into `box`.
     *
     * Guarded twice against a race that a viewer like this hits constantly:
     * the operator clicks through four tickers while the first fetch is still
     * in flight. `alive()` covers teardown; the selTicker re-check covers the
     * stale response, which would otherwise paint NKE's price under ABAT's
     * heading.
     */
    /**
     * Paint (or repaint) the quote header for the selected ticker.
     *
     * It lives above the document rather than in the run column: the run
     * column is a narrow list of dates, and a chart squeezed into it reads
     * worse than the same chart across the width of the document pane.
     */
    function showQuote(ticker) {
      quoteHost.innerHTML = '';
      if (!ticker) return;
      const box = el('div', 'sa-qbox');
      box.appendChild(el('div', 'sa-qloading', 'Loading quote…'));
      quoteHost.appendChild(box);
      paintQuote(box, ticker, quoteRange).catch((e) => rhost.log.error('quote failed', e));
    }

    async function paintQuote(box, ticker, range) {
      let res;
      try {
        res = await rhost.invoke('quote', { ticker, range });
      } catch (e) {
        res = { ok: false, error: String((e && e.message) || e) };
      }
      if (!alive() || ticker !== selTicker) return;

      box.innerHTML = '';
      if (!res || !res.ok) {
        // Distinct from "no data": the reason is shown, because a blank
        // header and a refused source must not look the same.
        box.appendChild(el('div', 'sa-qerr', (res && res.error) || 'no quote'));
        return;
      }

      const q = res.quote || {};
      const up = Number.isFinite(q.change) ? q.change >= 0 : true;

      const top = el('div', 'sa-qtop');
      const priceWrap = el('div', 'sa-qpricewrap');
      priceWrap.appendChild(el('span', 'sa-qprice', fmtMoney(q.price, q.currency)));
      if (Number.isFinite(q.change) && Number.isFinite(q.changePct)) {
        const sign = up ? '+' : '−';
        const chg = el('span', up ? 'sa-qchg sa-up' : 'sa-qchg sa-down',
          `${sign}${Math.abs(q.change).toFixed(2)} (${sign}${Math.abs(q.changePct).toFixed(2)}%)`);
        priceWrap.appendChild(chg);
      }
      top.appendChild(priceWrap);

      const picker = el('div', 'sa-qranges');
      for (const [key, label] of QUOTE_RANGES) {
        const b = el('button', key === range ? 'sa-qrange sa-qrange-on' : 'sa-qrange', label);
        b.addEventListener('click', () => {
          quoteRange = key;
          paintQuote(box, ticker, key).catch((e) => rhost.log.error('quote failed', e));
        });
        picker.appendChild(b);
      }
      top.appendChild(picker);
      box.appendChild(top);

      box.appendChild(priceChart(q.series, up, q.currency));
      box.appendChild(rangeBar(q));

      const stats = el('div', 'sa-qstats');
      const stat = (label, value) => {
        if (value === '—') return;
        const cell = el('div', 'sa-qstat');
        cell.appendChild(el('span', 'sa-qstatk', label));
        cell.appendChild(el('span', 'sa-qstatv', value));
        stats.appendChild(cell);
      };
      stat('Mkt cap', fmtCompact(q.marketCap));
      stat('Volume', fmtCompact(q.volume));
      stat('Day', Number.isFinite(q.dayLow) && Number.isFinite(q.dayHigh)
        ? `${fmtMoney(q.dayLow, '')} – ${fmtMoney(q.dayHigh, '')}` : '—');
      stat('Prev close', fmtMoney(q.prevClose, ''));
      box.appendChild(stats);

      // Every quote carries its own timestamp. A number with no "as of" is the
      // one thing a research viewer must not show.
      const foot = el('div', 'sa-qfoot');
      const when = fmtClock(q.marketTime || res.asOf);
      foot.appendChild(el('span', 'sa-qasof',
        res.stale ? `last good quote${when ? ` · ${when}` : ''} — source unreachable`
          : `as of ${when || 'now'}${q.exchange ? ` · ${q.exchange}` : ''}`));
      if (res.stale) foot.classList.add('sa-qstale');
      if (!Number.isFinite(q.marketCap)) {
        foot.appendChild(el('span', 'sa-qhint',
          'market cap needs an SEC contact email in settings'));
      }
      box.appendChild(foot);
    }

    function renderRuns() {
      runPane.innerHTML = '';
      const t = index.find((x) => x.ticker === selTicker);
      if (!t) {
        runPane.appendChild(el('div', 'sa-empty', 'Select a ticker.'));
        return;
      }

      const hdr = el('div', 'sa-runhdr');
      hdr.appendChild(el('div', 'sa-runticker', t.ticker));
      if (t.company) hdr.appendChild(el('div', 'sa-runcompany', t.company));
      hdr.appendChild(buildRerun(t));
      runPane.appendChild(hdr);

      for (const run of t.runs) {
        const box = el('div', 'sa-run');
        const head = el('div', 'sa-runhead');
        head.appendChild(el('span', 'sa-rundate', run.date));
        if (Number.isFinite(run.score)) {
          head.appendChild(el('span', scoreClass(run.score), String(run.score)));
        }
        if (run.conviction) head.appendChild(el('span', 'sa-conv', run.conviction));
        box.appendChild(head);

        const docs = el('div', 'sa-docs');
        for (const d of run.docs) {
          const btn = el('button', 'sa-docbtn', d.label);
          btn.dataset.saFile = d.file;
          btn.dataset.saDate = run.date;
          if (d.file === 'assessment.md') btn.classList.add('sa-docbtn-main');
          const size = fmtSize(d.size);
          btn.title = size ? `${d.file} — ${size}` : d.file;
          btn.addEventListener('click', () => {
            selDate = run.date;
            selDir = run.dir;
            showDoc(t.ticker, run.date, d.file).catch((e) => rhost.log.error('doc failed', e));
          });
          docs.appendChild(btn);
        }
        box.appendChild(docs);
        runPane.appendChild(box);
      }
      markDocSelection();
    }

    // --- ticker pane ---

    function selectTicker(ticker) {
      selTicker = ticker;
      for (const row of tickerPane.querySelectorAll('.sa-trow')) {
        row.classList.toggle('sa-selected', row.dataset.saTicker === ticker);
      }
      renderRuns();
      showQuote(ticker);

      // Open the newest assessment straight away: nobody opens a research
      // viewer to look at a list of dates.
      const t = index.find((x) => x.ticker === ticker);
      const newest = t && t.runs[0];
      const main = newest && newest.docs.find((d) => d.file === 'assessment.md');
      if (newest && main) {
        selDate = newest.date;
        selDir = newest.dir;
        showDoc(ticker, newest.date, main.file).catch((e) => rhost.log.error('doc failed', e));
      } else {
        docInner.innerHTML = '';
        docInner.appendChild(el('div', 'sa-empty', 'No assessment document in this run.'));
      }
    }

    function renderIndex(res) {
      tickerPane.innerHTML = '';
      runPane.innerHTML = '';
      quoteHost.innerHTML = '';
      docInner.innerHTML = '';

      if (!res || res.ok !== true) {
        rootLabel.textContent = '';
        const why = (res && res.error) || 'could not read the folder';
        const box = el('div', 'sa-empty');
        box.appendChild(el('div', null, `No research library: ${why}.`));
        box.appendChild(el('div', 'sa-hint', 'Open this from a session in your stocks workspace, or pick the folder that contains assessments/.'));
        tickerPane.appendChild(box);
        return;
      }

      index = res.tickers || [];
      runner = res.runner || null;
      requests = res.requests || {};
      rootLabel.textContent = res.root + (res.via === 'session' ? '' : '  (chosen)');
      rootLabel.title = res.via === 'session'
        ? `Found from the active session’s working directory: ${res.root}`
        : `Folder chosen in settings: ${res.root}`;

      if (!index.length) {
        tickerPane.appendChild(el('div', 'sa-empty', 'No assessments yet.'));
        docPane.appendChild(el('div', 'sa-empty', `Run ${RESEARCH_CMD} <ticker> to create one.`));
        return;
      }

      for (const t of index) {
        const row = el('div', 'sa-trow');
        row.dataset.saTicker = t.ticker;

        const main = el('div', 'sa-tmain');
        main.appendChild(el('span', 'sa-tname', t.ticker));
        if (Number.isFinite(t.latestScore)) {
          main.appendChild(el('span', scoreClass(t.latestScore), String(t.latestScore)));
        }
        if (Number.isFinite(t.trend) && t.trend !== 0) {
          const up = t.trend > 0;
          const chip = el('span', up ? 'sa-trend sa-trend-up' : 'sa-trend sa-trend-dn',
            `${up ? '▲' : '▼'}${Math.abs(t.trend)}`);
          chip.title = `${up ? 'Up' : 'Down'} ${Math.abs(t.trend)} since the previous assessment`;
          main.appendChild(chip);
        }
        row.appendChild(main);

        const meta = el('div', 'sa-tmeta');
        meta.appendChild(el('span', 'sa-tdate', t.latestDate));
        if (t.latestConviction) meta.appendChild(el('span', 'sa-conv', t.latestConviction));
        const n = t.runs.length;
        meta.appendChild(el('span', 'sa-truns', n === 1 ? '1 run' : `${n} runs`));
        row.appendChild(meta);

        // Staleness. Two of the workspace's four re-assessment triggers are
        // computable from disk; the chip says which one fired and never claims
        // to be the whole test.
        const st = t.stale || {};
        if (st.reasons && st.reasons.length) {
          const due = el('div', 'sa-due');
          // A passed catalyst outranks age: it is a specific event, where age
          // is only a timer.
          due.appendChild(el('span', 'sa-due-chip',
            st.passedCount > 0 ? 'catalyst passed' : `stale · ${st.ageDays}d`));
          due.title = `${st.reasons.join('\n')}\n\n`
            + 'Age and watchlist catalyst dates only — earnings and price-vs-SPY moves are not checked here.';
          row.appendChild(due);
        } else if (Number.isFinite(st.nextCatalystInDays) && st.nextCatalystInDays <= 21) {
          // Not due yet, but close enough that it is worth knowing before you
          // spend a run on it.
          const soon = el('div', 'sa-due');
          soon.appendChild(el('span', 'sa-due-soon', `catalyst in ${st.nextCatalystInDays}d`));
          soon.title = `Next watchlist catalyst: ${st.nextCatalyst}`;
          row.appendChild(soon);
        }

        row.addEventListener('click', () => selectTicker(t.ticker));
        tickerPane.appendChild(row);
      }

      // Keep the current selection across a reload when it still exists,
      // otherwise fall to the first ticker.
      const keep = index.some((t) => t.ticker === selTicker) ? selTicker : index[0].ticker;
      selectTicker(keep);
    }

    async function reload() {
      const my = ++indexSeq;
      tickerPane.innerHTML = '';
      tickerPane.appendChild(el('div', 'sa-empty', 'Loading…'));
      let res;
      try {
        res = await rhost.invoke('index', sessionName());
      } catch (e) {
        rhost.log.error('index fetch failed', e);
        res = null;
      }
      if (!alive() || my !== indexSeq) return;
      renderIndex(res);
    }

    return () => { reload().catch((e) => rhost.log.error('reload failed', e)); };
  }

  // --- slots ---------------------------------------------------------------

  rhost.ui.sidebar.footerButton({
    id: 'open',
    glyph: '◳',
    label: 'Stocks',
    tip: 'Browse past stock assessments',
    onClick: () => surface.open(),
  });

  rhost.ui.settings.section({
    id: 'prefs',
    title: 'Assessments folder',
    render(bodyEl, values) {
      bodyEl.innerHTML = '';
      const p = el('p', 'sa-set-note',
        'Leave blank to read the assessments/ folder of whichever session is active. Set a path to always read one workspace.');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'sa-set-input';
      input.placeholder = '/Users/you/projects/stocks';
      input.value = (values && typeof values.root === 'string') ? values.root : '';
      bodyEl.appendChild(p);
      bodyEl.appendChild(input);

      // Opt-in, and blank by default. The SEC's fair-access policy asks callers
      // to identify themselves; nothing is sent to the SEC until this is set,
      // and the address never goes anywhere else — the price source is called
      // with a generic plugin UA.
      const p2 = el('p', 'sa-set-note',
        'Market cap is read from SEC filings, which ask callers to identify themselves. '
        + 'Enter a contact email to enable it — sent only to sec.gov. Leave blank to skip market cap.');
      const contact = document.createElement('input');
      contact.type = 'text';
      contact.className = 'sa-set-contact';
      contact.placeholder = 'you@example.com';
      contact.value = (values && typeof values.secContact === 'string') ? values.secContact : '';
      bodyEl.appendChild(p2);
      bodyEl.appendChild(contact);
    },
    collect(bodyEl) {
      const input = bodyEl.querySelector('.sa-set-input');
      const contact = bodyEl.querySelector('.sa-set-contact');
      if (!input) return null;
      if (contact) {
        return { root: input.value.trim(), secContact: contact.value.trim() };
      }
      // Saved unvalidated on purpose: this is a free-text field the operator may
      // fill before the folder exists, and the engine already refuses a root
      // with no assessments/ at read time with a message naming the reason.
      return { root: input.value.trim() };
    },
  });

  return () => { torn = true; };
};
