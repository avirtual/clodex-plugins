'use strict';

/**
 * renderer.js — crypto-research. Browser context: DOM, no filesystem.
 *
 * One overlay: tickers on the left, dated runs in the middle, the document on
 * the right, with a live quote header above it.
 *
 * Nothing an agent wrote ever becomes markup. These documents are model-written
 * prose; the markdown renderer below builds nodes and sets every leaf through
 * textContent, so a document containing a <script> tag displays a <script> tag.
 */

/* --------------------------------------------------------------- helpers --- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

function fmtUsd(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${v.toFixed(2)}`;
  if (a >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toPrecision(3)}`;
}

function fmtPct(v, digits) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const d = typeof digits === 'number' ? digits : 1;
  return `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
}

function pctClass(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'cr-flat';
  if (v > 0) return 'cr-up';
  if (v < 0) return 'cr-down';
  return 'cr-flat';
}

function scoreBand(n) {
  if (typeof n !== 'number') return 'cr-band-none';
  if (n >= 75) return 'cr-band-hi';
  if (n >= 60) return 'cr-band-mid';
  if (n >= 45) return 'cr-band-low';
  return 'cr-band-bad';
}

/* -------------------------------------------------------------- markdown --- */

/**
 * A small markdown renderer that emits DOM, never HTML.
 *
 * Handles what these documents actually use: headings, bold/italic/code spans,
 * bullet and numbered lists, blockquotes, fenced code, pipe tables, rules.
 * Anything it does not recognise is emitted as text, which is the safe default.
 */
function renderMarkdown(md) {
  const frag = document.createDocumentFragment();
  const lines = String(md == null ? '' : md).split(/\r?\n/);
  let i = 0;

  const inline = (text, into) => {
    // Split on the span markers, keeping the delimiters, then style the pieces.
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) into.appendChild(document.createTextNode(text.slice(last, m.index)));
      const tok = m[0];
      if (tok.startsWith('**')) into.appendChild(el('strong', null, tok.slice(2, -2)));
      else if (tok.startsWith('`')) into.appendChild(el('code', 'cr-code', tok.slice(1, -1)));
      else if (tok.startsWith('[')) {
        const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        // A link is rendered as its text plus the bare URL. No anchor: a
        // document written by a model should not be one click from a fetch.
        into.appendChild(el('span', 'cr-linktext', lm ? lm[1] : tok));
        if (lm) into.appendChild(el('span', 'cr-linkurl', ` (${lm[2]})`));
      } else into.appendChild(el('em', null, tok.slice(1, -1)));
      last = m.index + tok.length;
    }
    if (last < text.length) into.appendChild(document.createTextNode(text.slice(last)));
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    if (/^```/.test(line)) {
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1;
      frag.appendChild(el('pre', 'cr-pre', buf.join('\n')));
      continue;
    }

    if (/^\s*(---|===|\*\*\*)\s*$/.test(line)) {
      frag.appendChild(el('hr', 'cr-hr'));
      i += 1;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const node = el(`h${Math.min(h[1].length + 1, 6)}`, 'cr-h');
      inline(h[2], node);
      frag.appendChild(node);
      i += 1;
      continue;
    }

    // Pipe table: a header row, a separator of dashes, then body rows.
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const table = el('table', 'cr-table');
      const thead = el('thead');
      const hr = el('tr');
      for (const c of cells(line)) { const th = el('th'); inline(c, th); hr.appendChild(th); }
      thead.appendChild(hr);
      table.appendChild(thead);
      i += 2;
      const tbody = el('tbody');
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const tr = el('tr');
        for (const c of cells(lines[i])) { const td = el('td'); inline(c, td); tr.appendChild(td); }
        tbody.appendChild(tr);
        i += 1;
      }
      table.appendChild(tbody);
      frag.appendChild(table);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      const bq = el('blockquote', 'cr-quote');
      inline(buf.join(' '), bq);
      frag.appendChild(bq);
      continue;
    }

    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line) && !bullet.test(line);
      const list = el(ordered ? 'ol' : 'ul', 'cr-list');
      while (i < lines.length && (bullet.test(lines[i]) || numbered.test(lines[i]))) {
        const li = el('li');
        inline(lines[i].replace(bullet, '').replace(numbered, ''), li);
        list.appendChild(li);
        i += 1;
      }
      frag.appendChild(list);
      continue;
    }

    const buf = [];
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|\s*>|\s*\|)/.test(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    if (buf.length) {
      const p = el('p', 'cr-p');
      inline(buf.join(' '), p);
      frag.appendChild(p);
    } else i += 1;
  }

  return frag;
}

/* --------------------------------------------------------------- sparkline --- */

/**
 * A bare sparkline is only a shape: scaled to its own extremes, a 76% decline
 * and a flat month draw identically. So this labels the high and low it is
 * scaled to, dashes the period's opening price, and dates both ends.
 *
 * Drawn in a stretched viewBox so it fits any pane width — which means nothing
 * inside the SVG can carry text or a stroke that must keep its proportions.
 * Labels are HTML positioned over the plot; the stroke uses non-scaling-stroke.
 */
function drawChart(box, series) {
  box.innerHTML = '';
  if (!Array.isArray(series) || series.length < 2) {
    box.appendChild(el('div', 'cr-chart-empty', 'no price series'));
    return;
  }

  const vals = series.map((p) => p.v);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const open = vals[0];
  const W = 1000;
  const H = 120;

  const x = (idx) => (idx / (series.length - 1)) * W;
  const y = (v) => H - ((v - lo) / span) * H;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'cr-chart-svg');

  const openY = y(open);
  const base = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  base.setAttribute('x1', '0'); base.setAttribute('x2', String(W));
  base.setAttribute('y1', String(openY)); base.setAttribute('y2', String(openY));
  base.setAttribute('class', 'cr-chart-base');
  svg.appendChild(base);

  const d = series.map((p, idx) => `${idx === 0 ? 'M' : 'L'}${x(idx).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');
  const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pathEl.setAttribute('d', d);
  pathEl.setAttribute('class', vals[vals.length - 1] >= open ? 'cr-chart-line cr-up-stroke' : 'cr-chart-line cr-down-stroke');
  svg.appendChild(pathEl);

  const plot = el('div', 'cr-chart-plot');
  plot.appendChild(svg);
  plot.appendChild(el('div', 'cr-chart-hi', fmtUsd(hi)));
  plot.appendChild(el('div', 'cr-chart-lo', fmtUsd(lo)));

  const dt = (ms) => new Date(ms).toISOString().slice(0, 10);
  const foot = el('div', 'cr-chart-foot');
  foot.appendChild(el('span', null, dt(series[0].t)));
  const move = ((vals[vals.length - 1] - open) / (open || 1)) * 100;
  const moveEl = el('span', `cr-chart-move ${pctClass(move)}`, `${fmtPct(move)} from open`);
  foot.appendChild(moveEl);
  foot.appendChild(el('span', null, dt(series[series.length - 1].t)));

  box.appendChild(plot);
  box.appendChild(foot);

  // Readout under the cursor. The plot is stretched, so map clientX back
  // through the box width rather than through SVG user units.
  plot.addEventListener('mousemove', (ev) => {
    const r = plot.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / (r.width || 1)));
    const idx = Math.round(frac * (series.length - 1));
    const p = series[idx];
    if (!p) return;
    const mv = ((p.v - open) / (open || 1)) * 100;
    moveEl.textContent = `${dt(p.t)} · ${fmtUsd(p.v)} · ${fmtPct(mv)}`;
    moveEl.className = `cr-chart-move ${pctClass(mv)}`;
  });
  plot.addEventListener('mouseleave', () => {
    moveEl.textContent = `${fmtPct(move)} from open`;
    moveEl.className = `cr-chart-move ${pctClass(move)}`;
  });
}

/* ------------------------------------------------------------- activation --- */

module.exports.activate = (rhost) => {
  // Named capability checks, same reasoning as the engine half: a missing API
  // throws here with a readable message rather than a TypeError from inside a
  // click handler two minutes later.
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
    throw new Error('this host has no rhost.sessions.active; a newer Clodex is needed to find the library');
  }

  let torn = false;
  let refresh = null;   // assigned by mount; the host always mounts before onOpen
  let isOpen = false;

  const surface = rhost.ui.surfaces.overlay({
    id: 'main',
    mount(rootEl) { refresh = wire(rootEl); },
    onOpen() { isOpen = true; if (refresh) refresh(); },
    onClose() { isOpen = false; },
  });

  /*
   * The engine emits `watch-changed` when an agent records a watch item through
   * [agent:cryptowatch]. Without this, an overlay left open while an agent
   * worked would keep showing the list as it was at open time.
   *
   * This does NOT replace the pull on open, it only removes the wait between
   * opens: events are unbuffered, so a window closed at emit time hears nothing,
   * ever. The payload is deliberately null — the emit is an invalidation hint on
   * `'all'`, and we re-pull rather than trusting anything carried across.
   *
   * Feature-checked at the point of use: a host without events.on loses live
   * refresh, not the viewer.
   */
  let offEvent = null;
  if (rhost.events && typeof rhost.events.on === 'function') {
    offEvent = rhost.events.on('watch-changed', () => {
      if (torn || !isOpen || !refresh) return;
      refresh();
    });
  }

  function wire(rootEl) {
    rootEl.innerHTML = '';

    // The host paints only a scrim. The panel is ours, or the controls float as
    // bare text on a dark backdrop and the plugin reads as broken.
    const modal = el('div', 'cr-modal');

    const topbar = el('div', 'cr-topbar');
    topbar.appendChild(el('div', 'cr-title', '◈ Crypto Research'));
    const rootLabel = el('div', 'cr-rootlabel', '');
    topbar.appendChild(rootLabel);
    const folderBtn = el('button', 'cr-btn', 'Folder…');
    topbar.appendChild(folderBtn);
    modal.appendChild(topbar);

    const body = el('div', 'cr-body');
    const colTickers = el('div', 'cr-col cr-col-tickers');
    const colRuns = el('div', 'cr-col cr-col-runs');
    const colDoc = el('div', 'cr-col cr-col-doc');
    body.appendChild(colTickers);
    body.appendChild(colRuns);
    body.appendChild(colDoc);
    modal.appendChild(body);

    rootEl.appendChild(modal);

    let state = { tickers: [], watch: [], selTicker: null, selRun: null, selDoc: null, range: '30d' };

    /* ------------------------------------------------------------ quote --- */

    async function paintQuote(box, ticker, coinId, range) {
      box.innerHTML = '';
      box.appendChild(el('div', 'cr-quote-loading', `loading ${ticker}…`));

      let res;
      try {
        res = await rhost.invoke('quote', { ticker, coinId, range });
      } catch (e) {
        rhost.log.error('quote failed', e);
        res = { state: 'failed', error: String((e && e.message) || e) };
      }
      if (torn) return;
      box.innerHTML = '';

      // Three outcomes, never confused: a source that is refusing must not look
      // like a source that is empty.
      if (!res || res.state === 'failed') {
        const f = el('div', 'cr-quote-failed');
        f.appendChild(el('span', 'cr-chip cr-chip-err', 'no market data'));
        f.appendChild(el('span', 'cr-quote-why', (res && res.error) || 'unknown error'));
        box.appendChild(f);
        return;
      }

      const q = res.quote || {};
      const head = el('div', 'cr-quote-head');
      head.appendChild(el('div', 'cr-quote-price', fmtUsd(q.price)));

      const changes = el('div', 'cr-quote-changes');
      for (const [lab, v] of [['24h', q.d1], ['7d', q.d7], ['30d', q.d30]]) {
        const c = el('span', `cr-quote-chg ${pctClass(v)}`);
        c.appendChild(el('span', 'cr-quote-chglab', lab));
        c.appendChild(el('span', null, fmtPct(v)));
        changes.appendChild(c);
      }
      head.appendChild(changes);

      const stamp = el('div', 'cr-quote-stamp');
      if (res.state === 'stale') {
        stamp.className = 'cr-quote-stamp cr-warn';
        stamp.textContent = `source unreachable — cached ${res.cachedAt ? new Date(res.cachedAt).toLocaleTimeString() : ''}`;
      } else {
        stamp.textContent = q.asOf ? `as of ${new Date(q.asOf).toLocaleTimeString()}` : '';
      }
      head.appendChild(stamp);
      box.appendChild(head);

      // An id we guessed is labelled as a guess, all the way to the UI: a symbol
      // is a ranking, not an identity, and a dead fork often outranks the live
      // protocol.
      if (res.ident && res.ident.guessed) {
        const g = el('div', 'cr-guess');
        g.appendChild(el('span', 'cr-chip cr-chip-warn', 'id guessed'));
        g.appendChild(el('span', null, ` resolved "${ticker}" to ${res.ident.name} (${res.ident.id}) by search rank`));
        if (res.ident.alternatives && res.ident.alternatives.length) {
          g.appendChild(el('span', 'cr-guess-alt',
            ` — also matched: ${res.ident.alternatives.map((a) => a.id).join(', ')}`));
        }
        box.appendChild(g);
      }

      const stats = el('div', 'cr-stats');
      const pair = (k, v) => {
        const d = el('div', 'cr-stat');
        d.appendChild(el('div', 'cr-stat-k', k));
        d.appendChild(el('div', 'cr-stat-v', v));
        stats.appendChild(d);
      };
      pair('Market cap', fmtUsd(q.marketCap));
      pair('FDV', fmtUsd(q.fdv));
      pair('Volume 24h', fmtUsd(q.volume));
      const floatPct = (typeof q.circulating === 'number' && typeof q.total === 'number' && q.total > 0)
        ? `${((q.circulating / q.total) * 100).toFixed(0)}%` : '—';
      pair('Circulating', floatPct);
      pair('ATH drawdown', q.athPct != null ? `${q.athPct.toFixed(0)}%` : '—');
      if (res.fng && res.fng.value != null) {
        pair('Fear & Greed', `${res.fng.value} ${res.fng.label || ''}${res.fng.ago != null ? ` (was ${res.fng.ago})` : ''}`);
      }
      box.appendChild(stats);

      const ranges = el('div', 'cr-ranges');
      for (const r of ['30d', '90d', '1y']) {
        const b = el('button', `cr-range${r === (res.range || range) ? ' cr-range-on' : ''}`, r);
        b.addEventListener('click', () => {
          state.range = r;
          paintQuote(box, ticker, coinId, r).catch((e) => rhost.log.error('quote failed', e));
        });
        ranges.appendChild(b);
      }
      box.appendChild(ranges);

      const chartBox = el('div', 'cr-chart');
      box.appendChild(chartBox);
      drawChart(chartBox, res.chart);
    }

    /* -------------------------------------------------------------- doc --- */

    async function showDoc(ticker, date, file) {
      state.selDoc = { ticker, date, file };
      colDoc.innerHTML = '';

      const t = state.tickers.find((x) => x.ticker === ticker);
      const quoteBox = el('div', 'cr-quote');
      colDoc.appendChild(quoteBox);
      // The header follows the TICKER, not the document, so clicking through a
      // run's findings files does not refetch or repaint it.
      paintQuote(quoteBox, ticker, t && t.coinId, state.range)
        .catch((e) => rhost.log.error('quote failed', e));

      const note = el('div', 'cr-docnote',
        "today's market data, next to a dated assessment — different moments, each stamped");
      colDoc.appendChild(note);

      const docBox = el('div', 'cr-doc');
      colDoc.appendChild(docBox);
      docBox.appendChild(el('div', 'cr-loading', 'loading…'));

      let res;
      try {
        res = await rhost.invoke('doc', { sessionName: rhost.sessions.active(), ticker, date, file });
      } catch (e) {
        rhost.log.error('doc fetch failed', e);
        res = { ok: false, error: String((e && e.message) || e) };
      }
      if (torn) return;

      docBox.innerHTML = '';
      if (!res || !res.ok) {
        docBox.appendChild(el('div', 'cr-err', (res && res.error) || 'could not read that file'));
        return;
      }

      /*
       * Prefer the host's renderer. It embodies the same rule as ours — build
       * nodes, never innerHTML — but it is the pinned, maintained copy: it caps
       * blockquote nesting so hostile input cannot overflow the stack, refuses
       * images outright (an <img src> is a network fetch on untrusted input),
       * and admits an anchor only for http/https. Ours is the fallback for a
       * host that does not carry it, not a preference.
       */
      if (rhost.lib && typeof rhost.lib.renderMarkdown === 'function') {
        docBox.classList.add('cr-doc-host');
        docBox.appendChild(rhost.lib.renderMarkdown(res.text));
      } else {
        docBox.classList.remove('cr-doc-host');
        docBox.appendChild(renderMarkdown(res.text));
      }
    }

    /* ------------------------------------------------------------ runs --- */

    function paintRuns(ticker) {
      colRuns.innerHTML = '';
      const t = state.tickers.find((x) => x.ticker === ticker);
      if (!t) return;

      colRuns.appendChild(el('div', 'cr-colhead', `${t.ticker} — ${t.runCount} run${t.runCount === 1 ? '' : 's'}`));

      const mine = state.watch.filter((w) => w.ticker === ticker);
      if (mine.length) {
        const wbox = el('div', 'cr-watchbox');
        wbox.appendChild(el('div', 'cr-watchhead', 'Watch items'));
        for (const w of mine) {
          const row = el('div', 'cr-watch');
          const top = el('div', 'cr-watch-top');
          if (w.due) {
            const days = Math.ceil((Date.parse(`${w.due}T00:00:00Z`) - Date.now()) / 86400000);
            const cls = days < 0 ? 'cr-chip cr-chip-dim' : days <= 7 ? 'cr-chip cr-chip-act' : 'cr-chip';
            top.appendChild(el('span', cls, days < 0 ? `passed ${-days}d ago` : `in ${days}d`));
          }
          top.appendChild(el('span', 'cr-watch-by', `${w.by || 'agent'} · ${String(w.at || '').slice(0, 10)}`));
          const x = el('button', 'cr-x', '×');
          x.title = 'remove';
          x.addEventListener('click', async () => {
            try {
              const r = await rhost.invoke('watchRemove', w.id);
              if (r && r.ok) { state.watch = r.watch; paintRuns(ticker); }
            } catch (e) { rhost.log.error('watchRemove failed', e); }
          });
          top.appendChild(x);
          row.appendChild(top);
          row.appendChild(el('div', 'cr-watch-note', w.note));
          wbox.appendChild(row);
        }
        colRuns.appendChild(wbox);
      }

      for (const run of t.runs) {
        const card = el('div', 'cr-run');
        const head = el('div', 'cr-run-head');
        head.appendChild(el('span', 'cr-run-date', run.date));
        if (typeof run.score === 'number') {
          head.appendChild(el('span', `cr-chip ${scoreBand(run.score)}`, String(run.score)));
        }
        if (run.conviction) head.appendChild(el('span', 'cr-chip cr-chip-dim', run.conviction));
        card.appendChild(head);

        for (const d of run.docs) {
          const b = el('button', 'cr-doclink', d.label);
          b.addEventListener('click', () => {
            colRuns.querySelectorAll('.cr-doclink').forEach((n) => n.classList.remove('cr-on'));
            b.classList.add('cr-on');
            showDoc(t.ticker, run.date, d.file).catch((e) => rhost.log.error('doc failed', e));
          });
          card.appendChild(b);
        }
        colRuns.appendChild(card);
      }
    }

    /* --------------------------------------------------------- tickers --- */

    function paintTickers() {
      colTickers.innerHTML = '';
      colTickers.appendChild(el('div', 'cr-colhead', `${state.tickers.length} ticker${state.tickers.length === 1 ? '' : 's'}`));

      if (!state.tickers.length) {
        colTickers.appendChild(el('div', 'cr-empty',
          'No assessments here yet. Run /crypto-research:crypto-research <token> on a seat holding this plugin.'));
        return;
      }

      for (const t of state.tickers) {
        const row = el('button', 'cr-tick');
        if (t.ticker === state.selTicker) row.classList.add('cr-on');

        const line1 = el('div', 'cr-tick-1');
        line1.appendChild(el('span', 'cr-tick-sym', t.ticker));
        if (typeof t.score === 'number') {
          line1.appendChild(el('span', `cr-chip ${scoreBand(t.score)}`, String(t.score)));
        }
        if (typeof t.delta === 'number' && t.delta !== 0) {
          line1.appendChild(el('span', `cr-delta ${t.delta > 0 ? 'cr-up' : 'cr-down'}`,
            `${t.delta > 0 ? '▲' : '▼'}${Math.abs(t.delta)}`));
        }
        row.appendChild(line1);

        const line2 = el('div', 'cr-tick-2');
        line2.appendChild(el('span', null, t.latest));
        if (t.conviction) line2.appendChild(el('span', 'cr-tick-conv', t.conviction));
        if (typeof t.ageDays === 'number' && t.ageDays >= 30) {
          line2.appendChild(el('span', 'cr-chip cr-chip-warn', `stale · ${t.ageDays}d`));
        }
        if (t.runCount > 1) line2.appendChild(el('span', 'cr-tick-runs', `${t.runCount} runs`));
        row.appendChild(line2);

        row.addEventListener('click', () => {
          state.selTicker = t.ticker;
          paintTickers();
          paintRuns(t.ticker);
          const newest = t.runs[0];
          const main = newest.docs.find((d) => d.file === 'assessment.md') || newest.docs[0];
          if (main) showDoc(t.ticker, newest.date, main.file).catch((e) => rhost.log.error('doc failed', e));
        });
        colTickers.appendChild(row);
      }
    }

    /* ---------------------------------------------------------- reload --- */

    async function reload() {
      colTickers.innerHTML = '';
      colTickers.appendChild(el('div', 'cr-loading', 'reading…'));

      let res;
      try {
        res = await rhost.invoke('index', rhost.sessions.active());
      } catch (e) {
        rhost.log.error('index fetch failed', e);
        res = { ok: false, error: String((e && e.message) || e) };
      }
      if (torn) return;

      if (!res || !res.ok) {
        colTickers.innerHTML = '';
        colTickers.appendChild(el('div', 'cr-err', (res && res.error) || 'could not read the library'));
        rootLabel.textContent = '';
        colRuns.innerHTML = '';
        colDoc.innerHTML = '';
        return;
      }

      state.tickers = res.tickers || [];
      state.watch = res.watch || [];
      rootLabel.textContent = `${res.root}${res.via === 'settings' ? ' (set in settings)' : ''}`;
      rootLabel.title = res.root;

      // Keep the selection across a reload when it still exists.
      if (state.selTicker && !state.tickers.some((t) => t.ticker === state.selTicker)) state.selTicker = null;
      paintTickers();
      if (state.selTicker) paintRuns(state.selTicker);
      else { colRuns.innerHTML = ''; colDoc.innerHTML = ''; }
    }

    folderBtn.addEventListener('click', async () => {
      if (typeof rhost.ui.pickDirectory !== 'function') {
        rhost.ui.showToast('This host cannot open a folder picker — set the path in the plugin settings instead',
          { kind: 'error' });
        return;
      }
      try {
        const dir = await rhost.ui.pickDirectory();
        if (!dir) return;
        const r = await rhost.invoke('setRoot', dir);
        if (!r || !r.ok) {
          rhost.ui.showToast((r && r.error) || 'Could not use that folder', { kind: 'error' });
          return;
        }
        await reload();
      } catch (e) {
        rhost.log.error('folder pick failed', e);
      }
    });

    return () => { reload().catch((e) => rhost.log.error('reload failed', e)); };
  }

  /* ----------------------------------------------------------- the slots --- */

  rhost.ui.sidebar.footerButton({
    id: 'open',
    glyph: '◈',
    label: 'Crypto',
    tip: 'Browse crypto research assessments',
    onClick: () => surface.open(),
  });

  rhost.ui.settings.section({
    id: 'prefs',
    title: 'Research library folder',
    render(bodyEl, values) {
      bodyEl.innerHTML = '';
      bodyEl.appendChild(el('p', 'cr-set-note',
        'Leave blank to read the research/ folder of whichever session is active (walking up to three levels). '
        + 'Set a path to always read one library.'));
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'cr-set-input';
      input.placeholder = '/Users/you/projects/crypto/research';
      input.value = (values && typeof values.root === 'string') ? values.root : '';
      bodyEl.appendChild(input);
    },
    collect(bodyEl) {
      const input = bodyEl.querySelector('.cr-set-input');
      if (!input) return null;
      // Saved unvalidated on purpose: the operator may fill this before the
      // folder exists, and the engine already refuses a bad root at read time
      // with a message naming the path.
      return { root: input.value.trim() };
    },
  });

  return () => {
    torn = true;
    if (offEvent) { try { offEvent(); } catch { /* already released */ } }
  };
};

// Exported for the tests; not part of the plugin surface.
module.exports.renderMarkdown = renderMarkdown;
module.exports._fmtUsd = fmtUsd;
module.exports._scoreBand = scoreBand;
