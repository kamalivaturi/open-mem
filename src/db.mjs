// Storage: settings, project detection, SQLite schema (FTS5 + embeddings), search.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME = process.env.OPEN_MEM_HOME || path.join(os.homedir(), '.open-mem');

export const TYPES = ['bugfix', 'feature', 'refactor', 'change', 'discovery', 'decision', 'security_note'];
export const ICONS = { bugfix: '●', feature: '◆', refactor: '↻', change: '✓', discovery: '○', decision: '⚖', security_note: '⚷' };

export const DEFAULTS = {
  provider: 'ollama',               // ollama | claude | openai
  model: 'qwen2.5:7b',              // ollama / openai-compatible model name
  ollamaUrl: 'http://127.0.0.1:11434',
  embedModel: 'nomic-embed-text',   // ollama embedding model; null disables semantic search
  openaiBaseUrl: 'https://openrouter.ai/api/v1',
  openaiApiKey: '',                 // or env OPEN_MEM_API_KEY
  claudeModel: 'haiku',             // used by provider "claude" (runs `claude -p` on your plan)
  language: 'English',
  batchSize: 8,                     // tool calls per observer request
  contextObservations: 25,
  contextSummaries: 1,
  skipTools: ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ToolSearch'],
  obsidianDir: null,                // write session notes here, e.g. "C:\\Vault\\claude\\open-mem"
  vaultDir: null,                   // index this whole vault; Claude searches it via vault_search
  vaultExclude: [],                 // vault folders never indexed, e.g. ["me/journal", "private"]
  contextNotes: 5,                  // related vault notes listed at session start
  viewerPort: 37778,
};

export function settings() {
  const file = path.join(HOME, 'settings.json');
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    fs.mkdirSync(HOME, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2));
    return { ...DEFAULTS };
  }
}

// Project = name of the nearest git root, else the folder name.
export function projectOf(cwd = process.cwd()) {
  const start = path.resolve(cwd);
  for (let p = start; ; p = path.dirname(p)) {
    if (fs.existsSync(path.join(p, '.git'))) return path.basename(p) || p;
    if (path.dirname(p) === p) return path.basename(start) || start;
  }
}

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, project TEXT NOT NULL, cwd TEXT, started_at INTEGER NOT NULL,
  ended_at INTEGER, summarize_at INTEGER, summarized_at INTEGER);
CREATE TABLE IF NOT EXISTS prompts(
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, project TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, project TEXT NOT NULL, tool TEXT NOT NULL,
  input TEXT, output TEXT, cwd TEXT, created_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS events_pending ON events(done, session_id);
CREATE TABLE IF NOT EXISTS observations(
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, project TEXT NOT NULL, type TEXT NOT NULL,
  title TEXT NOT NULL, subtitle TEXT, narrative TEXT, facts TEXT, concepts TEXT,
  files_read TEXT, files_modified TEXT, created_at INTEGER NOT NULL, embedding BLOB);
CREATE INDEX IF NOT EXISTS obs_project ON observations(project, created_at DESC);
CREATE TABLE IF NOT EXISTS summaries(
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, project TEXT NOT NULL, request TEXT,
  investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, notes TEXT, created_at INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, subtitle, narrative, facts, concepts, content='observations', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts); END;
CREATE TABLE IF NOT EXISTS notes(
  id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, mtime INTEGER NOT NULL,
  title TEXT NOT NULL, tags TEXT, body TEXT NOT NULL, indexed_at INTEGER NOT NULL, embedding BLOB);
CREATE INDEX IF NOT EXISTS notes_hash ON notes(hash);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, tags, body, content='notes', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, tags, body) VALUES (new.id, new.title, new.tags, new.body); END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, tags, body) VALUES ('delete', old.id, old.title, old.tags, old.body); END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, tags, body) VALUES ('delete', old.id, old.title, old.tags, old.body);
  INSERT INTO notes_fts(rowid, title, tags, body) VALUES (new.id, new.title, new.tags, new.body); END;
CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, facts, concepts)
  VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.facts, old.concepts); END;
`;

export function open(file = path.join(HOME, 'open-mem.db')) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function insertObservation(db, o, embedding) {
  return Number(db.prepare(`INSERT INTO observations
    (session_id, project, type, title, subtitle, narrative, facts, concepts, files_read, files_modified, created_at, embedding)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    o.session_id, o.project, o.type, o.title, o.subtitle || '', o.narrative || '',
    JSON.stringify(o.facts || []), JSON.stringify(o.concepts || []),
    JSON.stringify(o.files_read || []), JSON.stringify(o.files_modified || []),
    o.created_at || Date.now(), embedding ? Buffer.from(new Float32Array(embedding).buffer) : null,
  ).lastInsertRowid);
}

export const embedText = o => [o.title, o.subtitle, o.narrative, ...(o.facts || [])].filter(Boolean).join('\n');

const JSON_COLS = ['facts', 'concepts', 'files_read', 'files_modified'];
export function hydrate(row) {
  if (!row) return row;
  const { embedding, ...o } = row;
  for (const c of JSON_COLS) o[c] = JSON.parse(o[c] || '[]');
  return o;
}

function filters({ project, type, days }, alias = 'o') {
  const where = [], args = [];
  if (project) { where.push(`${alias}.project = ?`); args.push(project); }
  if (type) { where.push(`${alias}.type = ?`); args.push(type); }
  if (days) { where.push(`${alias}.created_at >= ?`); args.push(Date.now() - days * 864e5); }
  return { sql: where.length ? ' AND ' + where.join(' AND ') : '', args };
}

export const ftsQuery = q => (q.match(/[\p{L}\p{N}_]+/gu) || []).map(w => `"${w}"*`).join(' OR ');

export const toVec = blob => new Float32Array(new Uint8Array(blob).buffer);

export function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}

// Hybrid search: FTS5 bm25 ranking fused with vector cosine ranking (reciprocal rank fusion).
// No query -> most recent observations matching the filters.
export function search(db, opts = {}, queryVec = null) {
  const { query = '', limit = 20 } = opts;
  const f = filters(opts);
  const cols = 'o.id, o.project, o.type, o.title, o.subtitle, o.created_at';
  const fq = ftsQuery(query);
  if (!fq) {
    return db.prepare(`SELECT ${cols} FROM observations o WHERE 1=1${f.sql} ORDER BY o.created_at DESC LIMIT ?`)
      .all(...f.args, limit);
  }
  const score = new Map(), rows = new Map();
  const fts = db.prepare(`SELECT ${cols} FROM observations_fts JOIN observations o ON o.id = observations_fts.rowid
    WHERE observations_fts MATCH ?${f.sql} ORDER BY bm25(observations_fts) LIMIT 100`).all(fq, ...f.args);
  fts.forEach((r, i) => { rows.set(r.id, r); score.set(r.id, 1 / (60 + i)); });
  if (queryVec) {
    // ponytail: brute-force cosine over all embeddings; fine to ~50k observations, add sqlite-vec beyond that.
    const vec = db.prepare(`SELECT ${cols}, o.embedding FROM observations o WHERE o.embedding IS NOT NULL${f.sql}`).all(...f.args)
      .map(r => ({ r, s: cosine(queryVec, toVec(r.embedding)) }))
      .filter(x => x.s > 0.3).sort((a, b) => b.s - a.s).slice(0, 100);
    vec.forEach(({ r }, i) => { delete r.embedding; rows.set(r.id, r); score.set(r.id, (score.get(r.id) || 0) + 1 / (60 + i)); });
  }
  return [...score].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => rows.get(id));
}

// Observations around an anchor (by id, or best match for query), interleaved with prompts and summaries.
export function timeline(db, { id, query, before = 5, after = 5, project } = {}, queryVec = null) {
  if (!id && query) id = search(db, { query, project, limit: 1 }, queryVec)[0]?.id;
  const anchor = id && db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
  if (!anchor) return [];
  const cols = 'id, project, type, title, subtitle, created_at';
  const prev = db.prepare(`SELECT ${cols} FROM observations WHERE project = ? AND (created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(anchor.project, anchor.created_at, anchor.created_at, anchor.id, before);
  const next = db.prepare(`SELECT ${cols} FROM observations WHERE project = ? AND (created_at > ? OR (created_at = ? AND id > ?))
    ORDER BY created_at, id LIMIT ?`).all(anchor.project, anchor.created_at, anchor.created_at, anchor.id, after);
  const obs = [...prev.reverse(), { ...hydrate(anchor), anchor: true }, ...next].map(o => ({ kind: 'observation', ...o }));
  const to = obs.at(-1).created_at;
  // Prompts and summaries belong to the sessions shown; summaries are written after their observations,
  // so match them by session rather than by time window.
  const sids = [...new Set([anchor.session_id, ...db.prepare(`SELECT session_id FROM observations WHERE id IN (${obs.map(() => '?').join(',')})`)
    .all(...obs.map(o => o.id)).map(r => r.session_id)])];
  const inS = sids.map(() => '?').join(',');
  const prompts = db.prepare(`SELECT id, text, created_at FROM prompts WHERE session_id IN (${inS}) AND created_at <= ? ORDER BY created_at DESC LIMIT 10`)
    .all(...sids, to).map(p => ({ kind: 'prompt', ...p }));
  const sums = db.prepare(`SELECT * FROM summaries WHERE session_id IN (${inS})`).all(...sids).map(s => ({ kind: 'summary', ...s }));
  return [...obs, ...prompts, ...sums].sort((a, b) => a.created_at - b.created_at);
}

export const getObservations = (db, ids) =>
  ids.map(id => hydrate(db.prepare('SELECT * FROM observations WHERE id = ?').get(Number(id)))).filter(Boolean);

export const fmtDate = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
