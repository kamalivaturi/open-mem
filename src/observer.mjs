// Background pipeline: raw tool events -> compressed observations -> session summaries -> Obsidian notes.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, TYPES, ICONS, insertObservation, embedText, getObservations, cosine, toVec, tx } from './db.mjs';
import * as llm from './llm.mjs';
import { ingestVault } from './vault.mjs';

export const log = msg => fs.appendFileSync(path.join(HOME, 'open-mem.log'), `${new Date().toISOString()} ${msg}\n`);

const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const tag = (s, t) => unxml((s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1]?.trim() || '');
const tags = (s, t) => [...s.matchAll(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, 'g'))].map(m => unxml(m[1].trim())).filter(Boolean);
const block = (s, t) => s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1] || '';

export function parseObservations(xml) {
  return [...xml.matchAll(/<observation>([\s\S]*?)<\/observation>/g)].map(([, b]) => ({
    type: TYPES.includes(tag(b, 'type')) ? tag(b, 'type') : 'change',
    title: tag(b, 'title'),
    subtitle: tag(b, 'subtitle'),
    narrative: tag(b, 'narrative'),
    facts: tags(block(b, 'facts'), 'fact'),
    concepts: tags(b, 'concept'),
    files_read: tags(block(b, 'files_read'), 'file'),
    files_modified: tags(block(b, 'files_modified'), 'file'),
  })).filter(o => o.title);
}

export function parseSummary(xml) {
  const b = block(xml, 'summary');
  if (!b) return null;
  return Object.fromEntries(['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'].map(k => [k, tag(b, k)]));
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function observationPrompt({ project, prompt, events, language }) {
  const calls = events.map(e =>
    `<call tool="${esc(e.tool)}" cwd="${esc(e.cwd)}">\n<input>${esc(e.input)}</input>\n<output>${esc(e.output)}</output>\n</call>`).join('\n');
  return `You are the memory observer for an AI coding session in project "${project}".
Below are tool calls the agent just made. Record what a future session would need to know:
what was learned, built, fixed, decided or configured, with concrete names, paths and values.
Skip routine noise (directory listings, failed lookups, files read with nothing notable).
Describe the work itself, never yourself. Write all text in ${language}.
If nothing is worth remembering, output exactly <none/>.

Output only XML: zero to three <observation> blocks, each covering one distinct finding.
<observation>
  <type>${TYPES.join('|')}</type>
  <title>short specific searchable title, max 10 words</title>
  <subtitle>one sentence of detail</subtitle>
  <facts><fact>standalone concrete fact</fact></facts>
  <narrative>2-4 sentences: context, what happened, why it matters</narrative>
  <concepts><concept>how-it-works|why-it-exists|what-changed|problem-solution|gotcha|pattern|trade-off</concept></concepts>
  <files_read><file>path</file></files_read>
  <files_modified><file>path</file></files_modified>
</observation>

The user's latest request: ${esc(prompt || '(unknown)')}

<tool_calls>
${calls}
</tool_calls>`;
}

export function summaryPrompt({ project, prompts, observations, language }) {
  const obs = observations.map(o => `- [${o.type}] ${o.title}: ${o.subtitle} ${o.facts.join('; ')}`).join('\n');
  return `Summarize this AI coding session in project "${project}" for whoever continues it next.
Use only the information below. Be specific and brief. Write all text in ${language}.
Output only XML:
<summary>
  <request>what the user asked for</request>
  <investigated>what was explored</investigated>
  <learned>key insights</learned>
  <completed>what is now done</completed>
  <next_steps>what remains, concretely</next_steps>
  <notes>gotchas or open questions, or empty</notes>
</summary>

User prompts:
${prompts.map(p => `- ${esc(p.text.slice(0, 500))}`).join('\n') || '(none)'}

Observations:
${obs || '(none)'}`;
}

// Near-duplicate check against the project's recent memory (same title, or cosine > 0.95).
function isDuplicate(db, project, o, vec) {
  const recent = db.prepare('SELECT title, embedding FROM observations WHERE project = ? ORDER BY id DESC LIMIT 200').all(project);
  const t = o.title.toLowerCase();
  return recent.some(r => r.title.toLowerCase() === t || (vec && r.embedding && cosine(vec, toVec(r.embedding)) > 0.95));
}

async function observeBatch(db, s, deps, sessionId) {
  const events = db.prepare('SELECT * FROM events WHERE done = 0 AND session_id = ? ORDER BY id LIMIT ?').all(sessionId, s.batchSize);
  const { project } = events[0];
  const prompt = db.prepare('SELECT text FROM prompts WHERE session_id = ? AND created_at <= ? ORDER BY id DESC LIMIT 1')
    .get(sessionId, events.at(-1).created_at)?.text;
  const parsed = parseObservations(await deps.complete(observationPrompt({ project, prompt, events, language: s.language }), s));
  const vecs = (await deps.embed(parsed.map(embedText), s)) || [];
  let added = 0;
  tx(db, () => {
    parsed.forEach((o, i) => {
      if (isDuplicate(db, project, o, vecs[i])) return;
      insertObservation(db, { ...o, session_id: sessionId, project, created_at: events.at(-1).created_at }, vecs[i]);
      added++;
    });
    db.prepare(`UPDATE events SET done = 1 WHERE id IN (${events.map(() => '?').join(',')})`).run(...events.map(e => e.id));
  });
  return added;
}

async function summarize(db, s, deps, sess) {
  const since = sess.summarized_at || 0;
  const fresh = db.prepare(`SELECT (SELECT COUNT(*) FROM observations WHERE session_id = ?1 AND created_at > ?2)
    + (SELECT COUNT(*) FROM prompts WHERE session_id = ?1 AND created_at > ?2) n`).get(sess.id, since).n;
  const mark = () => db.prepare('UPDATE sessions SET summarized_at = ? WHERE id = ?').run(Date.now(), sess.id);
  if (!fresh) return mark(), false;
  const prompts = db.prepare('SELECT text FROM prompts WHERE session_id = ? ORDER BY id').all(sess.id);
  const ids = db.prepare('SELECT id FROM observations WHERE session_id = ? ORDER BY id').all(sess.id).map(r => r.id);
  const observations = getObservations(db, ids);
  if (!observations.length) return mark(), false;   // nothing learned yet; prompts alone aren't a summary
  const sum = parseSummary(await deps.complete(summaryPrompt({ project: sess.project, prompts, observations, language: s.language }), s));
  if (!sum) throw new Error('observer returned no <summary>');
  db.prepare(`INSERT INTO summaries (session_id, project, request, investigated, learned, completed, next_steps, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET request=excluded.request, investigated=excluded.investigated,
    learned=excluded.learned, completed=excluded.completed, next_steps=excluded.next_steps, notes=excluded.notes, created_at=excluded.created_at`)
    .run(sess.id, sess.project, sum.request, sum.investigated, sum.learned, sum.completed, sum.next_steps, sum.notes, Date.now());
  mark();
  if (s.obsidianDir) exportObsidian(db, s.obsidianDir, sess, sum, observations);
  return true;
}

// Drain all pending work. Stops at the first model error and leaves the rest queued for the next run.
export async function drain(db, s, deps = llm) {
  const stats = { observations: 0, summaries: 0 };
  if (s.vaultDir) {
    try { stats.vault = await ingestVault(db, s, deps.embed); } catch (e) { log(`vault index failed: ${e.message}`); }
  }
  try {
    for (let next; (next = db.prepare('SELECT session_id FROM events WHERE done = 0 ORDER BY id LIMIT 1').get());) {
      stats.observations += await observeBatch(db, s, deps, next.session_id);
    }
    const due = db.prepare('SELECT * FROM sessions WHERE summarize_at IS NOT NULL AND (summarized_at IS NULL OR summarized_at < summarize_at)').all();
    for (const sess of due) stats.summaries += (await summarize(db, s, deps, sess)) ? 1 : 0;
  } catch (e) {
    log(`drain stopped: ${e.message}`);
    stats.error = e.message;
  }
  // The GUI shows a failure banner only while the most recent run failed.
  fs.writeFileSync(path.join(HOME, 'last-drain.json'), JSON.stringify({ at: Date.now(), ...stats }));
  return stats;
}

// Single-runner lock: one drain at a time; a lock whose pid is gone is stale.
// ponytail: an event that lands as the holder exits waits for the next hook to trigger a drain.
export async function withLock(fn) {
  const file = path.join(HOME, 'drain.lock');
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
  } catch {
    let pid = 0;
    try { pid = Number(fs.readFileSync(file, 'utf8')); } catch { return withLock(fn); }
    try { process.kill(pid, 0); return null; } catch { fs.rmSync(file, { force: true }); return withLock(fn); }
  }
  try { return await fn(); } finally { fs.rmSync(file, { force: true }); }
}

// ---------- Obsidian ----------
const safe = s => String(s).replace(/[\\/:*?"<>|#^[\]]/g, '-').trim() || 'untitled';
const day = ms => new Date(ms).toISOString().slice(0, 10);

export function exportObsidian(db, dir, sess, sum, observations) {
  const folder = path.join(dir, safe(sess.project));
  fs.mkdirSync(folder, { recursive: true });
  const name = `${day(sess.started_at)} ${sess.id.slice(0, 8)}`;
  const section = (h, t) => (t ? `## ${h}\n${t}\n\n` : '');
  const obs = observations.map(o =>
    `- ${ICONS[o.type] || '•'} **${o.type}** ${o.title}${o.subtitle ? ` — ${o.subtitle}` : ''} \`#${o.id}\`` +
    o.facts.map(f => `\n  - ${f}`).join('')).join('\n');
  fs.writeFileSync(path.join(folder, `${name}.md`),
    `---\ndate: ${day(sess.started_at)}\nproject: ${JSON.stringify(sess.project)}\nsession: ${sess.id}\ntags: [open-mem]\n---\n` +
    `# ${(sum.request || 'Session').split('\n')[0].slice(0, 120)}\n\nProject: [[${safe(sess.project)}]]\n\n` +
    section('Investigated', sum.investigated) + section('Learned', sum.learned) + section('Completed', sum.completed) +
    section('Next steps', sum.next_steps) + section('Notes', sum.notes) + section('Observations', obs));

  // Project index note: every summarized session, newest first, as wikilinks.
  const rows = db.prepare(`SELECT s.request, x.id, x.started_at FROM summaries s JOIN sessions x ON x.id = s.session_id
    WHERE s.project = ? ORDER BY x.started_at DESC`).all(sess.project);
  fs.writeFileSync(path.join(folder, `${safe(sess.project)}.md`),
    `---\nproject: ${JSON.stringify(sess.project)}\ntags: [open-mem, open-mem-index]\n---\n# ${sess.project} — open-mem sessions\n\n` +
    rows.map(r => `- [[${day(r.started_at)} ${r.id.slice(0, 8)}]] ${(r.request || '').split('\n')[0].slice(0, 100)}`).join('\n') + '\n');
}
