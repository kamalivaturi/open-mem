// Claude Code lifecycle hooks. Every hook is fast: it only writes to SQLite and, when there is
// work, spawns a detached drain process. Model calls never block Claude.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, settings, projectOf, ICONS, fmtDate } from './db.mjs';
import { redact, clip } from './redact.mjs';
import { searchNotes } from './vault.mjs';

const BIN = fileURLToPath(new URL('../bin/open-mem.mjs', import.meta.url));

export function spawnDrain() {
  if (process.env.OPEN_MEM_NO_SPAWN) return;   // tests drive drain() directly
  spawn(process.execPath, [BIN, 'drain'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Redact the full text before clipping: clipping first can cut a secret short enough to slip past the patterns.
const text = v => (typeof v === 'string' ? v : JSON.stringify(v) ?? '');

const skipped = (tool, s) =>
  (tool.startsWith('mcp__') && tool.includes('open-mem')) ||
  s.skipTools.some(p => (p.endsWith('*') ? tool.startsWith(p.slice(0, -1)) : tool === p));

// Text injected at SessionStart: last session's summary plus a compact index of recent observations.
export function renderContext(db, project, s) {
  const sums = db.prepare('SELECT * FROM summaries WHERE project = ? ORDER BY created_at DESC LIMIT ?').all(project, s.contextSummaries);
  const obs = db.prepare('SELECT id, type, title, created_at FROM observations WHERE project = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(project, s.contextObservations);
  // Vault notes that mention this project, best match first. Words under 3 characters (e.g. "C" for C:\)
  // would prefix-match almost every note, so they are not searched.
  const terms = (project.match(/[\p{L}\p{N}_]{3,}/gu) || []).join(' ');
  const notes = s.contextNotes && terms ? searchNotes(db, terms, null, s.contextNotes) : [];
  if (!sums.length && !obs.length && !notes.length) return '';
  const out = [`# open-mem: memory from earlier sessions in "${project}"`,
    'Search deeper with the open-mem MCP tools: search -> timeline -> get_observations (fetch full details only for ids you need).'];
  for (const m of sums) {
    out.push('', `## Session ${fmtDate(m.created_at)}`);
    for (const [k, label] of [['request', 'Request'], ['completed', 'Completed'], ['learned', 'Learned'], ['next_steps', 'Next steps'], ['notes', 'Notes']]) {
      if (m[k]) out.push(`**${label}:** ${m[k]}`);
    }
  }
  if (obs.length) {
    out.push('', '## Recent observations (newest first)');
    for (const o of obs) out.push(`#${o.id} ${fmtDate(o.created_at)} ${ICONS[o.type] || '•'} ${o.type}: ${o.title}`);
  }
  if (notes.length) {
    out.push('', '## Related notes in your Obsidian vault (vault_search for more)');
    for (const n of notes) out.push(`- ${n.title} (${n.path.replace(/\\/g, '/')})`);
  }
  return out.join('\n');
}

export function handleHook(input, s = settings(), db = open()) {
  if (process.env.OPEN_MEM_DISABLE || !input?.session_id) return '';
  const now = Date.now();
  const project = projectOf(input.cwd);
  db.prepare('INSERT INTO sessions (id, project, cwd, started_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING')
    .run(input.session_id, project, input.cwd || '', now);

  switch (input.hook_event_name) {
    case 'SessionStart': {
      // Leftovers from a crashed session, and a fresh incremental scan of the Obsidian vault.
      if (s.vaultDir || db.prepare('SELECT 1 FROM events WHERE done = 0 LIMIT 1').get()) spawnDrain();
      return renderContext(db, project, s);
    }
    case 'UserPromptSubmit':
      if (input.prompt?.trim()) {
        db.prepare('INSERT INTO prompts (session_id, project, text, created_at) VALUES (?,?,?,?)')
          .run(input.session_id, project, clip(redact(input.prompt), 4000), now);
      }
      return '';
    case 'PostToolUse': {
      const tool = input.tool_name || 'unknown';
      if (skipped(tool, s)) return '';
      db.prepare('INSERT INTO events (session_id, project, tool, input, output, cwd, created_at) VALUES (?,?,?,?,?,?,?)').run(
        input.session_id, project, tool,
        clip(redact(text(input.tool_input)), 2000), clip(redact(text(input.tool_response)), 3000), input.cwd || '', now);
      const { n } = db.prepare('SELECT COUNT(*) n FROM events WHERE done = 0 AND session_id = ?').get(input.session_id);
      if (n >= s.batchSize) spawnDrain();
      return '';
    }
    case 'Stop':
    case 'SessionEnd': {
      const end = input.hook_event_name === 'SessionEnd';
      db.prepare(`UPDATE sessions SET summarize_at = ?${end ? ', ended_at = ?' : ''} WHERE id = ?`)
        .run(...(end ? [now, now] : [now]), input.session_id);
      spawnDrain();
      return '';
    }
    default:
      return '';
  }
}
