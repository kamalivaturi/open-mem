// Obsidian vault index: incremental, deduplicated full-text (+ optional semantic) index of every note.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ftsQuery, nearest, fuse, tx } from './db.mjs';

const MAX_BODY = 50_000;

function parseNote(file, text) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = fm?.[1] || '';
  const body = (fm ? text.slice(fm[0].length) : text).slice(0, MAX_BODY);
  const title = meta.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] || body.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(file, '.md');
  // Only the `tags:` key: inline array, block list, or space/comma-separated scalar.
  const fmTags = meta.match(/^tags:[ \t]*\[(.*)\][ \t]*$/m)?.[1].split(',')
    ?? meta.match(/^tags:[ \t]*\r?\n((?:[ \t]*-[ \t]+.*(?:\r?\n|$))+)/m)?.[1].split(/\r?\n/).map(l => l.replace(/^[ \t]*-[ \t]+/, ''))
    ?? meta.match(/^tags:[ \t]*(\S.*)$/m)?.[1].split(/[\s,]+/) ?? [];
  const inline = [...body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map(m => m[1]);
  const tags = [...new Set([...fmTags, ...inline].map(t => t.trim().replace(/^["'#]|["']$/g, '')).filter(Boolean))].join(' ');
  return { title, tags, body };
}

// Excluded: dot folders (.obsidian, .trash, .git), node_modules, open-mem's own export folder
// (so session memories never loop back in as duplicates) and any vaultExclude folders.
function excluded(rel, s) {
  const parts = rel.split(/[\\/]/);
  if (parts.some(p => p.startsWith('.') || p === 'node_modules')) return true;
  const norm = rel.replace(/\\/g, '/').toLowerCase();
  const own = s.obsidianDir && path.relative(s.vaultDir, s.obsidianDir);
  const skip = [...(s.vaultExclude || []), ...(own && !own.startsWith('..') && !path.isAbsolute(own) ? [own] : [])];
  return skip.some(x => { const e = x.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase(); return e && (norm === e || norm.startsWith(e + '/')); });
}

function* walk(root, s, dir = root) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name), rel = path.relative(root, full);
    if (excluded(rel, s)) continue;
    if (e.isDirectory()) yield* walk(root, s, full);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) yield rel;
  }
}

// Incremental: unchanged files (same mtime) are skipped without reading; changed files are re-read and
// only rewritten when their content hash changed; identical content at a second path is not stored twice;
// notes deleted from the vault leave the index.
export async function ingestVault(db, s, embed = null) {
  const stats = { scanned: 0, added: 0, updated: 0, removed: 0, duplicates: 0 };
  if (!s.vaultDir || !fs.existsSync(s.vaultDir)) return stats;
  const known = new Map(db.prepare('SELECT path, hash, mtime FROM notes').all().map(r => [r.path, r]));
  const hashes = new Set([...known.values()].map(r => r.hash));
  const seen = new Set(), changed = [];
  for (const rel of walk(s.vaultDir, s)) {
    stats.scanned++;
    seen.add(rel);
    const full = path.join(s.vaultDir, rel);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    const mtime = Math.floor(st.mtimeMs), prev = known.get(rel);
    if (prev && prev.mtime === mtime) continue;
    const text = fs.readFileSync(full, 'utf8');
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    if (prev && prev.hash === hash) { db.prepare('UPDATE notes SET mtime = ? WHERE path = ?').run(mtime, rel); continue; }
    if (!prev && hashes.has(hash)) { stats.duplicates++; continue; }   // same note copied elsewhere
    hashes.add(hash);
    changed.push({ rel, mtime, hash, prev: !!prev, ...parseNote(rel, text) });
  }
  const gone = [...known.keys()].filter(p => !seen.has(p));
  // ponytail: whole-note embeddings (title + first 2k chars); chunk long notes if recall on them matters.
  const vecs = [];
  for (let i = 0; embed && i < changed.length; i += 32) {
    const got = await embed(changed.slice(i, i + 32).map(n => `${n.title}\n${n.tags}\n${n.body.slice(0, 2000)}`), s);
    if (!got) break;
    vecs.push(...got);
  }
  const now = Date.now();
  tx(db, () => {
    for (const p of gone) db.prepare('DELETE FROM notes WHERE path = ?').run(p);
    changed.forEach((n, i) => {
      const blob = vecs[i] ? Buffer.from(new Float32Array(vecs[i]).buffer) : null;
      db.prepare(`INSERT INTO notes (path, hash, mtime, title, tags, body, indexed_at, embedding) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, mtime=excluded.mtime, title=excluded.title, tags=excluded.tags,
        body=excluded.body, indexed_at=excluded.indexed_at, embedding=excluded.embedding`)
        .run(n.rel, n.hash, n.mtime, n.title, n.tags, n.body, now, blob);
    });
  });
  stats.removed = gone.length;
  stats.added = changed.filter(n => !n.prev).length;
  stats.updated = changed.length - stats.added;
  return stats;
}

// Hybrid note search (bm25 + cosine, reciprocal rank fusion) returning a snippet around the match.
export function searchNotes(db, query, queryVec = null, limit = 10) {
  const fq = ftsQuery(query || '');
  if (!fq) return [];
  const fts = db.prepare(`SELECT n.id, n.path, n.title, n.tags, snippet(notes_fts, 2, '«', '»', ' … ', 24) snippet
    FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts, 5, 2, 1) LIMIT 100`).all(fq);
  const vec = queryVec
    ? nearest(db.prepare('SELECT id, path, title, tags, substr(body, 1, 240) snippet, embedding FROM notes WHERE embedding IS NOT NULL').all(), queryVec, 0.35)
    : [];
  return fuse([fts, vec], limit);
}

// Live watcher: re-index (incrementally) a moment after any markdown file changes.
export function watchVault(db, s, embed, onIndexed = () => {}) {
  if (!s.vaultDir || !fs.existsSync(s.vaultDir)) return null;
  let timer = null, running = false;
  const run = async () => {
    if (running) { timer = setTimeout(run, 2000); return; }
    running = true;
    try { onIndexed(await ingestVault(db, s, embed)); } catch (e) { onIndexed({ error: e.message }); }
    running = false;
  };
  // Watch the canonical long path: on Windows an 8.3 short path (C:\Users\JOHNSM~1) makes libuv
  // abort the whole process when a change is reported under the long name.
  const w = fs.watch(fs.realpathSync.native(s.vaultDir), { recursive: true }, (_, file) => {
    if (file && !String(file).toLowerCase().endsWith('.md')) return;
    clearTimeout(timer);
    timer = setTimeout(run, 1500);
  });
  w.on('error', e => onIndexed({ error: `vault watcher stopped: ${e.message}` }));
  run();
  return w;
}
