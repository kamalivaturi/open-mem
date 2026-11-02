// Local web GUI + JSON API. Binds to 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, DEFAULTS, open, settings, search, timeline, getObservations, hydrate } from './db.mjs';
import { complete, embed, embedQuery, ping } from './llm.mjs';
import { drain, withLock } from './observer.mjs';
import { ingestVault, watchVault } from './vault.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const MASK = '••••••••';
const SETTINGS_FILE = path.join(HOME, 'settings.json');

const day = ms => new Date(ms).toISOString().slice(0, 10);

function stats(db) {
  const one = sql => db.prepare(sql).get().n;
  const since = Date.now() - 30 * 864e5;
  const daily = Object.fromEntries(db.prepare('SELECT created_at FROM observations WHERE created_at >= ?').all(since)
    .reduce((m, r) => m.set(day(r.created_at), (m.get(day(r.created_at)) || 0) + 1), new Map()));
  let lastDrain = null;
  try { lastDrain = JSON.parse(fs.readFileSync(path.join(HOME, 'last-drain.json'), 'utf8')); } catch {}
  return {
    observations: one('SELECT COUNT(*) n FROM observations'),
    sessions: one('SELECT COUNT(*) n FROM sessions'),
    summaries: one('SELECT COUNT(*) n FROM summaries'),
    pending: one('SELECT COUNT(*) n FROM events WHERE done = 0'),
    notes: one('SELECT COUNT(*) n FROM notes'),
    notesIndexedAt: db.prepare('SELECT MAX(indexed_at) n FROM notes').get().n,
    watching: !!watcher,
    projects: db.prepare('SELECT project, COUNT(*) n, MAX(created_at) last FROM observations GROUP BY project ORDER BY last DESC').all(),
    types: db.prepare('SELECT type, COUNT(*) n FROM observations GROUP BY type ORDER BY n DESC').all(),
    daily: Array.from({ length: 30 }, (_, i) => { const d = day(since + (i + 1) * 864e5); return { day: d, n: daily[d] || 0 }; }),
    lastDrain,
  };
}

function sessions(db, project) {
  return db.prepare(`SELECT x.id, x.project, x.started_at, x.ended_at, s.request, s.completed, s.next_steps,
      (SELECT COUNT(*) FROM observations o WHERE o.session_id = x.id) observations,
      (SELECT COUNT(*) FROM prompts p WHERE p.session_id = x.id) prompts
    FROM sessions x LEFT JOIN summaries s ON s.session_id = x.id
    WHERE (?1 IS NULL OR x.project = ?1) ORDER BY x.started_at DESC LIMIT 200`).all(project || null)
    .filter(r => r.observations || r.request);
}

function saveSettings(body) {
  const cur = settings(), next = { ...cur };
  for (const [k, def] of Object.entries(DEFAULTS)) {
    if (!(k in body)) continue;
    let v = body[k];
    if (k === 'openaiApiKey' && v === MASK) continue;
    if (typeof def === 'number') v = v === '' || v == null || !Number.isFinite(Number(v)) ? def : Number(v);   // 0 is a valid value
    else if (Array.isArray(def)) v = Array.isArray(v) ? v : String(v).split(',').map(x => x.trim()).filter(Boolean);
    else v = v === '' || v == null ? (def === null ? null : '') : String(v);
    next[k] = v;
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

const masked = s => ({ ...s, openaiApiKey: s.openaiApiKey ? MASK : '' });

// Models the observer can switch to: installed Ollama models (live), Claude aliases, and the current one.
async function models(s) {
  let ollama = [];
  try {
    const r = await fetch(`${s.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    ollama = ((await r.json()).models || []).map(m => m.name).filter(n => !/embed/i.test(n));
  } catch {}
  return { ollama, claude: ['haiku', 'sonnet', 'opus'], current: { provider: s.provider, model: s.model, claudeModel: s.claudeModel } };
}

// One vault watcher per viewer process, restarted when the vault link changes.
let watcher = null;
function restartWatcher(db) {
  watcher?.close();
  watcher = null;
  const s = settings();
  if (s.vaultDir && fs.existsSync(s.vaultDir)) watcher = watchVault(db, s, embed);
}

async function linkVault(db, b) {
  let dir = path.resolve(String(b.vaultDir || '').trim().replace(/^["']|["']$/g, ''));
  if (!b.vaultDir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
  dir = fs.realpathSync.native(dir);   // canonical long path (no 8.3 short names)
  const isVault = fs.existsSync(path.join(dir, '.obsidian'));
  const patch = { vaultDir: dir, obsidianDir: b.exportNotes ? path.join(dir, 'claude', 'open-mem') : null };
  if (b.vaultExclude !== undefined) patch.vaultExclude = b.vaultExclude;
  const s = saveSettings(patch);
  const result = await ingestVault(db, s, embed);
  restartWatcher(db);
  return { linked: dir, isVault, ...result };
}

// quick: reachability + installed models in milliseconds. full: a real generation round trip.
async function testProvider(s, mode) {
  if (mode !== 'full') return { mode: 'quick', ...(await ping(s)) };
  const t = performance.now();
  const out = { mode: 'full', provider: s.provider };
  try {
    const reply = await complete('Reply with exactly: OK', s);
    out.ok = /ok/i.test(reply); out.reply = reply.slice(0, 80);
  } catch (e) { out.ok = false; out.error = e.message; }
  out.ms = performance.now() - t;
  out.embeddings = s.embedModel ? !!(await embed(['ping'], s)) : null;
  return out;
}

async function body(req) {
  let b = '';
  for await (const c of req) { b += c; if (b.length > 1e6) throw new Error('body too large'); }
  return b ? JSON.parse(b) : {};
}

export function createServer(db = open()) {
  return http.createServer(async (req, res) => {
    const send = (code, data, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(type === 'application/json' ? JSON.stringify(data) : data);
    };
    // DNS-rebinding guard + custom header on writes (forces a CORS preflight that we never answer).
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost'].includes(host)) return send(403, { error: 'forbidden host' });
    if (req.method !== 'GET' && req.headers['x-open-mem'] !== '1') return send(403, { error: 'missing x-open-mem header' });

    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname, q = Object.fromEntries(url.searchParams);
    const s = settings();
    try {
      if (p === '/' || p === '/index.html') return send(200, fs.readFileSync(path.join(ROOT, 'viewer.html')), 'text/html; charset=utf-8');
      if (p.startsWith('/fonts/') && /^[\w.-]+\.woff2$/.test(path.basename(p))) {
        const f = path.join(ROOT, '..', 'fonts', path.basename(p));
        return fs.existsSync(f) ? send(200, fs.readFileSync(f), 'font/woff2') : send(404, { error: 'no font' });
      }
      if (p === '/api/stats') return send(200, stats(db));
      if (p === '/api/search') {
        const vec = await embedQuery(q.q, s);
        return send(200, { hybrid: !!vec, results: search(db, { query: q.q, project: q.project, type: q.type, days: Number(q.days) || 0, limit: Number(q.limit) || 100 }, vec) });
      }
      let m;
      if ((m = p.match(/^\/api\/observations\/(\d+)$/))) {
        if (req.method === 'DELETE') {
          const r = db.prepare('DELETE FROM observations WHERE id = ?').run(Number(m[1]));
          return send(r.changes ? 200 : 404, { deleted: Number(r.changes) });
        }
        const o = getObservations(db, [m[1]])[0];
        return o ? send(200, o) : send(404, { error: 'not found' });
      }
      if ((m = p.match(/^\/api\/timeline\/(\d+)$/))) return send(200, timeline(db, { id: Number(m[1]), before: 6, after: 6 }));
      if (p === '/api/sessions') return send(200, sessions(db, q.project));
      if ((m = p.match(/^\/api\/sessions\/([\w-]+)$/))) {
        const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get(m[1]);
        if (!sess) return send(404, { error: 'not found' });
        return send(200, {
          session: sess,
          summary: db.prepare('SELECT * FROM summaries WHERE session_id = ?').get(m[1]) || null,
          prompts: db.prepare('SELECT text, created_at FROM prompts WHERE session_id = ? ORDER BY id').all(m[1]),
          observations: db.prepare('SELECT * FROM observations WHERE session_id = ? ORDER BY created_at, id').all(m[1]).map(hydrate),
        });
      }
      if (p === '/api/settings') {
        if (req.method === 'PUT') return send(200, masked(saveSettings(await body(req))));
        return send(200, { settings: masked(s), file: SETTINGS_FILE });
      }
      if (p === '/api/drain' && req.method === 'POST') {
        const r = await withLock(() => drain(db, s));
        return send(200, r ?? { busy: true });
      }
      if (p === '/api/test-provider' && req.method === 'POST') return send(200, await testProvider(s, q.mode));
      if (p === '/api/models') return send(200, await models(s));
      if (p === '/api/vault' && req.method === 'POST') return send(200, await linkVault(db, await body(req)));
      if (p === '/api/vault' && req.method === 'DELETE') {
        // Also stop exporting session notes when the export folder lives inside the unlinked vault.
        const rel = s.vaultDir && s.obsidianDir ? path.relative(s.vaultDir, s.obsidianDir) : '..';
        saveSettings({ vaultDir: null, ...(!rel.startsWith('..') && !path.isAbsolute(rel) ? { obsidianDir: null } : {}) });
        db.exec('DELETE FROM notes');
        restartWatcher(db);
        return send(200, { unlinked: true });
      }
      if (p === '/api/vault/reindex' && req.method === 'POST') return send(200, await ingestVault(db, s, embed));
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: e.message });
    }
  });
}

export function serveViewer(port = settings().viewerPort) {
  const db = open();
  const srv = createServer(db);
  restartWatcher(db);   // keep the vault index current while the GUI is open
  srv.listen(port, '127.0.0.1', () => console.log(`open-mem viewer: http://127.0.0.1:${port}`));
  return srv;
}
