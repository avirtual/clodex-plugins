'use strict';

// spill-browser — read the bodies Clodex filed out of seats' transcripts.
//
// Two sources, joined on agent + id:
//   ~/.clodex/spill/<agent>/<id>.md      the body, raw, no header. The name is a
//                                        content hash: it carries no time and no
//                                        kind.
//   ~/.clodex/wire-shadow-diag.jsonl     `"type":"wire-spill"` rows carry the
//                                        metadata {ts, agent, verb, id, bytes, head}.
//                                        Append-only and never pruned, so it is
//                                        read incrementally by byte offset.
// A file with no index row still lists, dated by mtime, as kind `unknown` (or
// `scratch` when its first line says it is a scratch episode result).
//
// An index row whose file is gone — core removes a seat's spill dir with the
// seat, and the ticket loop retires every hand on accept — is recovered from
// the ticket boards when it can be: `task` bodies also live in
// ~/.clodex/projects/*/tickets.json (spec, respecs, report, rounds, rework
// reasons). The id IS the body's content hash, so a board string whose hash
// equals it is that body exactly, not a guess from the head line. A row with
// neither a file nor a match does not list: there is nothing to read.
//
// Read-only. Nothing here writes, and nothing here is cached on disk.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Re-derived rather than imported: nothing exports it to plugins. The
// CLODEX_HOME half mirrors clodex-paths.js defaultClodexHome.
const CLODEX_ROOT = process.env.CLODEX_HOME || path.join(os.homedir(), '.clodex');
const SPILL_ROOT = path.join(CLODEX_ROOT, 'spill');
const DIAG = path.join(CLODEX_ROOT, 'wire-shadow-diag.jsonl');
const PROJECTS = path.join(CLODEX_ROOT, 'projects');

// Same character rule as core's session names. Not the containment check —
// '.' and '..' pass it; realpath + prefix in fileFor() is.
const AGENT_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
const ID_RE = /^[0-9a-f]{16}$/;

const PREVIEW_BYTES = 600;       // enough for a first line, never the body
const READ_MAX = 2 * 1024 * 1024; // core caps a spill well below this
const LIST_MAX = 2000;
const WATCH_DEBOUNCE_MS = 400;

let teardown = null;

module.exports.activate = (host) => {
  const index = new Map();   // "agent/id" -> { ts, agent, id, verb, bytes, head }
  const previews = new Map(); // "agent/id" -> first line. Content-addressed, so never stale.
  let offset = 0;
  let carry = '';
  let realRoot = null;
  // "agent/id" -> { text, ticket } for index rows whose file is gone, rebuilt
  // only when a board changes or a new file goes missing.
  let recovered = new Map();
  let recoveredSig = '';

  // Cached only on success: ~/.clodex exists before any plugin loads, but a
  // failed realpath cached here would blank every read for the process.
  const root = () => {
    if (realRoot) return realRoot;
    try { realRoot = fs.realpathSync(CLODEX_ROOT); } catch { return null; }
    return realRoot;
  };

  // Resolve a spill file and confine it to the Clodex root. Confining to the
  // spill root itself would be too tight: core links a seat's spill dir to
  // ~/.clodex/sessions/<agent>/spill, which resolves outside spill/.
  const fileFor = (agent, id) => {
    if (!AGENT_RE.test(agent) || !ID_RE.test(id)) return null;
    const r = root();
    if (!r) return null;
    let real;
    try { real = fs.realpathSync(path.join(SPILL_ROOT, agent, `${id}.md`)); } catch { return null; }
    return real.startsWith(r + path.sep) ? real : null;
  };

  // Pull any rows appended since the last read. Returns how many were new.
  const ingest = () => {
    let size;
    try { size = fs.statSync(DIAG).size; } catch { return 0; }
    // Shorter than our offset: the file was replaced. Start over.
    if (size < offset) { offset = 0; carry = ''; index.clear(); }
    if (size === offset) return 0;

    let added = 0;
    let fd;
    try {
      fd = fs.openSync(DIAG, 'r');
      const CHUNK = 1 << 20;
      const buf = Buffer.alloc(CHUNK);
      while (offset < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - offset), offset);
        if (n <= 0) break;
        offset += n;
        const text = carry + buf.toString('utf8', 0, n);
        const lines = text.split('\n');
        // The last piece is a partial line until a newline arrives for it.
        carry = lines.pop();
        for (const line of lines) {
          if (!line.includes('"wire-spill"')) continue;
          let r;
          try { r = JSON.parse(line); } catch { continue; }
          if (!r || r.type !== 'wire-spill') continue;
          if (typeof r.agent !== 'string' || typeof r.id !== 'string') continue;
          const key = `${r.agent}/${r.id}`;
          const prev = index.get(key);
          // The same body filed twice is one file; show its latest filing.
          if (prev && prev.ts >= r.ts) continue;
          index.set(key, {
            ts: Number(r.ts) || 0,
            agent: r.agent,
            id: r.id,
            verb: typeof r.verb === 'string' ? r.verb.replace(/\./g, ' ') : 'unknown',
            bytes: Number(r.bytes) || null,
            head: typeof r.head === 'string' ? r.head : null,
          });
          if (!prev) added++;
        }
      }
    } catch (e) {
      host.log.warn(`reading the spill index failed — ${(e && e.message) || e}`);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    return added;
  };

  // Every file on disk, keyed like the index. ~300 files today; a readdir per
  // list is cheaper than keeping a second watcher honest.
  const scanFiles = () => {
    const out = new Map();
    let agents;
    try { agents = fs.readdirSync(SPILL_ROOT); } catch { return out; }
    for (const agent of agents) {
      if (!AGENT_RE.test(agent)) continue;
      let names;
      try { names = fs.readdirSync(path.join(SPILL_ROOT, agent)); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.md')) continue;
        const id = name.slice(0, -3);
        if (ID_RE.test(id)) out.set(`${agent}/${id}`, { agent, id });
      }
    }
    return out;
  };

  const firstLine = (key, file) => {
    if (previews.has(key)) return previews.get(key);
    let line = '';
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(PREVIEW_BYTES);
      const n = fs.readSync(fd, buf, 0, PREVIEW_BYTES, 0);
      const text = buf.toString('utf8', 0, n);
      line = (text.split('\n').find((l) => l.trim()) || '').trim();
    } catch { /* unreadable: no preview */ } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    previews.set(key, line);
    return line;
  };

  const kindOf = (verb) => verb.split(' ')[0];

  // Core files a scratch episode's result with no wire-spill row, but its
  // first line names it, so it lists as `scratch` rather than `unknown`.
  const SCRATCH_RE = /^Scratch episode result\b/;
  const verbFromBody = (first) => (SCRATCH_RE.test(first) ? 'scratch' : 'unknown');

  // Core's spill id: sha256 of the body as written, first 16 hex.
  const idOf = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex').slice(0, 16);

  const boards = () => {
    let dirs;
    try { dirs = fs.readdirSync(PROJECTS); } catch { return []; }
    const out = [];
    for (const d of dirs) {
      const file = path.join(PROJECTS, d, 'tickets.json');
      try { out.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch { /* no board */ }
    }
    return out;
  };

  // Hash every long string on every ticket and keep the ones a missing spill
  // wants. Walks the whole record rather than naming fields, so a body that
  // core files under a field added later is still found.
  const recover = (missing) => {
    const list = boards();
    const sig = list.map((b) => `${b.file}@${b.mtime}`).join('|') + `#${[...missing.keys()].sort().join(',')}`;
    if (sig === recoveredSig) return;
    recoveredSig = sig;
    recovered = new Map();
    if (!missing.size) return;

    const wanted = new Map();   // id -> ["agent/id", ...]
    for (const [key, m] of missing) {
      if (!wanted.has(m.id)) wanted.set(m.id, []);
      wanted.get(m.id).push(key);
    }
    const take = (text, ticket) => {
      for (const t of [text, text.trim()]) {
        const keys = wanted.get(idOf(t));
        if (keys) for (const k of keys) if (!recovered.has(k)) recovered.set(k, { text: t, ticket });
      }
    };
    const walk = (v, ticket, depth) => {
      if (typeof v === 'string') { if (v.length >= 200) take(v, ticket); return; }
      if (!v || typeof v !== 'object' || depth > 6) return;
      for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, ticket, depth + 1);
    };
    for (const b of list) {
      let tickets;
      try { tickets = JSON.parse(fs.readFileSync(b.file, 'utf8')); } catch { continue; }
      if (!Array.isArray(tickets)) continue;
      for (const t of tickets) if (t && typeof t.id === 'string') walk(t, t.id, 0);
    }
  };

  const rows = () => {
    ingest();
    const files = scanFiles();
    const out = [];
    for (const [key, f] of files) {
      const file = fileFor(f.agent, f.id);
      if (!file) continue;
      let meta = index.get(key);
      if (!meta) {
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        const first = firstLine(key, file);
        meta = { ts: st.mtimeMs, agent: f.agent, id: f.id, verb: verbFromBody(first), bytes: st.size, head: null };
      }
      out.push({ ...meta, kind: kindOf(meta.verb), first: firstLine(key, file) });
    }

    const missing = new Map();
    for (const [key, meta] of index) if (!files.has(key) && meta.verb.startsWith('task ')) missing.set(key, meta);
    recover(missing);
    for (const [key, r] of recovered) {
      const meta = missing.get(key);
      if (!meta) continue;
      const first = (r.text.split('\n').find((l) => l.trim()) || '').trim();
      out.push({ ...meta, kind: kindOf(meta.verb), first, ticket: r.ticket });
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  };

  // Hint the open windows when a new spill row lands. The diag file takes many
  // other row types too, so the hint fires only when ingest found a spill.
  let watcher = null;
  let timer = null;
  const onDiag = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      // 'all' carries invalidation hints only: no count, no row.
      if (ingest() > 0) host.events.emit('changed', null, 'all');
    }, WATCH_DEBOUNCE_MS);
  };
  try { watcher = fs.watch(DIAG, onDiag); } catch (e) {
    host.log.info(`not watching the spill index (${(e && e.message) || e}); the overlay still refreshes on open`);
  }

  const disposers = [
    host.ipc.handle('list', (opts) => {
      const o = opts && typeof opts === 'object' ? opts : {};
      const kind = typeof o.kind === 'string' && o.kind ? o.kind : null;
      const agent = typeof o.agent === 'string' && o.agent ? o.agent : null;

      const all = rows();
      let shown = all;
      if (kind) shown = shown.filter((r) => r.kind === kind);
      if (agent) shown = shown.filter((r) => r.agent === agent);

      return {
        ok: true,
        total: shown.length,
        rows: shown.slice(0, LIST_MAX),
        kinds: [...new Set(all.map((r) => r.kind))].sort(),
        agents: [...new Set(all.map((r) => r.agent))].sort(),
      };
    }),

    host.ipc.handle('read', (opts) => {
      const o = opts && typeof opts === 'object' ? opts : {};
      const agent = String(o.agent || '');
      const id = String(o.id || '');
      const file = fileFor(agent, id);
      if (!file) {
        const r = recovered.get(`${agent}/${id}`);
        return r ? { ok: true, text: r.text, ticket: r.ticket } : { ok: false, error: 'no such spill' };
      }
      try {
        const st = fs.statSync(file);
        if (st.size > READ_MAX) return { ok: false, error: `too large to show (${st.size} B)` };
        return { ok: true, text: fs.readFileSync(file, 'utf8') };
      } catch (e) {
        return { ok: false, error: (e && e.code) || 'unreadable' };
      }
    }),
  ];

  teardown = () => {
    for (const d of disposers) { try { d(); } catch { /* already gone */ } }
    if (timer) clearTimeout(timer);
    if (watcher) try { watcher.close(); } catch { /* already closed */ }
    index.clear();
    previews.clear();
    recovered.clear();
  };

  host.log.info('activated');
};

module.exports.deactivate = () => {
  const t = teardown;
  teardown = null;
  if (t) t();
};
