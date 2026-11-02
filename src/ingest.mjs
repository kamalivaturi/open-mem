// Ingestion: one deep module that keeps the `items` store in step with any Source.
//
// A Source is a small adapter:
//   { name, kind, retain?, dedup?, list() -> iterable of { key, stamp, load() -> text|null },
//     parse(item, text) -> { title, body, kind?, tags?, meta?, project?, started_at?, updated_at? } | null }
// `stamp` is a cheap version marker (an mtime, an updatedAt). ingest() does the rest: skips unchanged
// items without loading them, re-parses only when the content hash changed, drops cross-key duplicates
// when the source asks for it, embeds new content, and handles items that disappeared: mirrored
// sources delete them, retained sources (archives, like Claude transcripts that Claude Code deletes
// after ~30 days) keep them and mark them missing.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ftsQuery, nearest, fuse, tx } from './db.mjs';

const sha1 = t => crypto.createHash('sha1').update(t).digest('hex');

export async function ingest(db, source, embed = null, s = {}) {
  const stats = { scanned: 0, added: 0, updated: 0, removed: 0, duplicates: 0 };
  const known = new Map(db.prepare('SELECT key, stamp, hash, missing_at FROM items WHERE source = ?').all(source.name).map(r => [r.key, r]));
  const hashes = new Set([...known.values()].map(r => r.hash));
  // Items the adapter declined (parse -> null) are remembered by stamp, so they aren't re-read every run.
  const skips = new Map(db.prepare('SELECT key, stamp FROM ingest_skips WHERE source = ?').all(source.name).map(r => [r.key, r.stamp]));
  const seen = new Set(), changed = [], touched = [], skipped = [];
  for (const item of source.list()) {
    stats.scanned++;
    seen.add(item.key);
    const prev = known.get(item.key), stamp = String(item.stamp);
    if (prev && prev.stamp === stamp && !prev.missing_at) continue;
    if (!prev && skips.get(item.key) === stamp) continue;
    const text = item.load();
    if (text == null) continue;
    const hash = sha1(text);
    if (prev && prev.hash === hash) { touched.push([stamp, item.key]); continue; }
    if (!prev && source.dedup && hashes.has(hash)) { stats.duplicates++; continue; }
    const row = source.parse(item, text);
    if (!row) { if (!prev) skipped.push([item.key, stamp]); continue; }
    hashes.add(hash);
    changed.push({ key: item.key, stamp, hash, prev: !!prev, ...row });
  }
  const gone = [...known].filter(([k, r]) => !seen.has(k) && !r.missing_at).map(([k]) => k);

  // ponytail: one embedding per item (title + tags + first 2k chars); chunk long items if recall on them matters.
  const vecs = [];
  for (let i = 0; embed && i < changed.length; i += 32) {
    const got = await embed(changed.slice(i, i + 32).map(n => `${n.title}\n${n.tags || ''}\n${n.body.slice(0, 2000)}`), s);
    if (!got) break;
    vecs.push(...got);
  }

  const now = Date.now();
  tx(db, () => {
    for (const [stamp, key] of touched) db.prepare('UPDATE items SET stamp = ?, missing_at = NULL WHERE source = ? AND key = ?').run(stamp, source.name, key);
    for (const [key, stamp] of skipped) {
      db.prepare('INSERT INTO ingest_skips (source, key, stamp) VALUES (?,?,?) ON CONFLICT(source, key) DO UPDATE SET stamp = excluded.stamp').run(source.name, key, stamp);
    }
    for (const key of gone) {
      if (source.retain) db.prepare('UPDATE items SET missing_at = ? WHERE source = ? AND key = ?').run(now, source.name, key);
      else db.prepare('DELETE FROM items WHERE source = ? AND key = ?').run(source.name, key);
    }
    changed.forEach((n, i) => {
      db.prepare(`INSERT INTO items (source, kind, key, stamp, hash, title, tags, body, meta, project, started_at, updated_at, missing_at, embedding)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?) ON CONFLICT(source, key) DO UPDATE SET kind=excluded.kind, stamp=excluded.stamp,
        hash=excluded.hash, title=excluded.title, tags=excluded.tags, body=excluded.body, meta=excluded.meta, project=excluded.project,
        started_at=excluded.started_at, updated_at=excluded.updated_at, missing_at=NULL, embedding=excluded.embedding`).run(
        source.name, n.kind || source.kind, n.key, n.stamp, n.hash, n.title, n.tags || '', n.body, JSON.stringify(n.meta || {}),
        n.project || null, n.started_at || null, n.updated_at || now, vecs[i] ? Buffer.from(new Float32Array(vecs[i]).buffer) : null);
    });
  });
  stats.removed = gone.length;
  stats.added = changed.filter(n => !n.prev).length;
  stats.updated = changed.length - stats.added;
  return stats;
}

const hydrateItem = r => r && ({ ...r, meta: JSON.parse(r.meta || '{}'), embedding: undefined });

// Hybrid recall over ingested items (bm25 + cosine, reciprocal rank fusion), with a match snippet.
export function searchItems(db, query, { kinds, project, limit = 10 } = {}, queryVec = null) {
  const fq = ftsQuery(query || '');
  if (!fq) return [];
  const where = [], args = [];
  if (kinds?.length) { where.push(`i.kind IN (${kinds.map(() => '?').join(',')})`); args.push(...kinds); }
  if (project) { where.push('i.project = ?'); args.push(project); }
  const and = where.length ? ` AND ${where.join(' AND ')}` : '';
  const cols = 'i.id, i.source, i.kind, i.key, i.title, i.tags, i.meta, i.project, i.started_at, i.updated_at, i.missing_at';
  const fts = db.prepare(`SELECT ${cols}, snippet(items_fts, 3, '«', '»', ' … ', 24) snippet FROM items_fts JOIN items i ON i.id = items_fts.rowid
    WHERE items_fts MATCH ?${and} ORDER BY bm25(items_fts, 6, 3, 3, 1) LIMIT 100`).all(fq, ...args);
  const vec = queryVec
    ? nearest(db.prepare(`SELECT ${cols}, substr(i.body, 1, 240) snippet, i.embedding FROM items i WHERE i.embedding IS NOT NULL${and}`).all(...args), queryVec, 0.35)
    : [];
  return fuse([fts, vec], limit).map(hydrateItem);
}

// Most recent items of a kind (registry views: projects, scheduled tasks, past sessions).
export const listItems = (db, kind, { project, limit = 200 } = {}) =>
  db.prepare(`SELECT id, source, kind, key, title, tags, meta, project, started_at, updated_at, missing_at, purpose, substr(body, 1, 400) excerpt
    FROM items WHERE kind = ?1 AND (?2 IS NULL OR project = ?2) ORDER BY COALESCE(updated_at, started_at) DESC LIMIT ?3`)
    .all(kind, project || null, limit).map(hydrateItem);

export const getItem = (db, id) => hydrateItem(db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id)));

// Re-ingest a moment after anything under `dir` changes (used for the Obsidian vault).
export function watch(db, source, dir, embed, s, onIndexed = () => {}) {
  if (!dir || !fs.existsSync(dir)) return null;
  let timer = null, running = false;
  const run = async () => {
    if (running) { timer = setTimeout(run, 2000); return; }
    running = true;
    try { onIndexed(await ingest(db, source, embed, s)); } catch (e) { onIndexed({ error: e.message }); }
    running = false;
  };
  // Watch the canonical long path: on Windows an 8.3 short path (C:\Users\JOHNSM~1) makes libuv
  // abort the whole process when a change is reported under the long name.
  const w = fs.watch(fs.realpathSync.native(dir), { recursive: true }, (_, file) => {
    if (file && !String(file).toLowerCase().endsWith('.md')) return;
    clearTimeout(timer);
    timer = setTimeout(run, 1500);
  });
  w.on('error', e => onIndexed({ error: `watcher stopped: ${e.message}` }));
  run();
  return w;
}
