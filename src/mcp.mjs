// MCP stdio server (newline-delimited JSON-RPC 2.0). Progressive disclosure:
// search (cheap index) -> timeline (context) -> get_observations (full detail, only for chosen ids).
import fs from 'node:fs';
import readline from 'node:readline';
import { ingest, searchItems, listItems, getItem } from './ingest.mjs';
import { vaultSource } from './sources.mjs';
import { open, settings, search, timeline, getObservations, insertObservation, embedText, projectOf, TYPES, ICONS, fmtDate } from './db.mjs';
import { embed, embedQuery } from './llm.mjs';
import { redact } from './redact.mjs';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const TOOLS = [
  {
    name: 'search',
    description: 'Step 1/3: search long-term memory of past sessions (hybrid keyword + semantic). Returns a compact index (id, date, type, title). Follow with timeline or get_observations for the ids that matter.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'What to look for; omit for most recent' },
      project: { type: 'string', description: 'Project name; omit to search all projects' },
      type: { type: 'string', enum: TYPES },
      days: { type: 'number', description: 'Only the last N days' },
      limit: { type: 'number', description: 'Default 20' },
    } },
  },
  {
    name: 'timeline',
    description: 'Step 2/3: what happened around an observation: neighbouring observations, user prompts and session summaries in time order. Give an id, or a query to anchor on its best match.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'number' }, query: { type: 'string' }, project: { type: 'string' },
      before: { type: 'number', description: 'Default 5' }, after: { type: 'number', description: 'Default 5' },
    } },
  },
  {
    name: 'get_observations',
    description: 'Step 3/3: full details (facts, narrative, files) for specific observation ids. Batch all ids in one call.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'number' } } }, required: ['ids'] },
  },
  {
    name: 'save_memory',
    description: 'Explicitly save something worth remembering in future sessions (a decision, preference, gotcha).',
    inputSchema: { type: 'object', properties: {
      title: { type: 'string' }, text: { type: 'string' }, type: { type: 'string', enum: TYPES },
      project: { type: 'string', description: 'Defaults to the current project' },
    }, required: ['title', 'text'] },
  },
  {
    name: 'vault_search',
    description: "Search the user's linked Obsidian vault (every note is indexed and kept current; hybrid keyword + semantic). Returns note titles, paths, tags and a snippet. Use it for the user's own knowledge, decisions, notes and preferences.",
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'past_sessions',
    description: 'Search or browse every recorded Claude session: Claude Code CLI, Claude Desktop (Code tab) and imported claude.ai chats, including sessions Claude Code has since deleted. Give a query to search, nothing for the most recent, or an id for the full conversation (user prompts and Claude replies, redacted).',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string' }, id: { type: 'number' }, project: { type: 'string' }, limit: { type: 'number', description: 'Default 15' },
    } },
  },
  {
    name: 'projects',
    description: "Registry of the user's projects (every folder Claude has worked in): purpose, intention, path, remote and recent activity. No arguments lists them all; give a name for one project's full detail.",
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  },
  {
    name: 'scheduled_tasks',
    description: "Registry of the user's scheduled tasks in Claude Desktop and Cowork: schedule, enabled state, purpose and intention, prompt. Includes tasks that were deleted (marked). Give a name for one task's full detail.",
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  },
];

const when = ms => (ms ? fmtDate(ms) : 'unknown date');
const gone = r => (r.missing_at ? ' [deleted at source; kept in memory]' : '');

function registry(db, kind, name) {
  const rows = listItems(db, kind);
  if (!rows.length) return kind === 'task' ? 'No scheduled tasks recorded (none found in Claude Desktop or Cowork).' : 'No projects recorded yet.';
  const pick = name && rows.find(r => r.title.toLowerCase() === name.toLowerCase()) || (name && rows.find(r => r.title.toLowerCase().includes(name.toLowerCase())));
  if (name && !pick) return `No ${kind} named "${name}". Known: ${rows.map(r => r.title).join(', ')}`;
  if (pick) {
    const r = getItem(db, pick.id);
    return [`${r.title}${gone(r)}`, kind === 'project' ? `Path: ${r.meta.path}${r.meta.remote ? `\nRemote: ${r.meta.remote}` : ''}`
      : `Where: ${r.meta.surface} · Schedule: ${r.meta.schedule || 'n/a'} · ${r.meta.enabled ? 'enabled' : 'disabled'}${r.meta.lastRunAt ? ` · last run ${r.meta.lastRunAt}` : ''}`,
      r.purpose ? `\n${r.purpose}` : '\n(Purpose not written yet; source material below.)', `\n---\n${r.body.slice(0, 6000)}`].join('\n');
  }
  return rows.map(r => `${r.title}${gone(r)}  ${kind === 'project' ? `(${r.meta.path})` : `(${r.meta.surface}; ${r.meta.schedule || 'no schedule'}; ${r.meta.enabled ? 'enabled' : 'disabled'})`}\n  ${(r.purpose || r.excerpt || '').replace(/\s+/g, ' ').slice(0, 220)}`).join('\n\n');
}

const line = o => `#${o.id}  ${fmtDate(o.created_at)}  ${ICONS[o.type] || '•'} ${o.type.padEnd(13)} [${o.project}] ${o.title}`;

export async function callTool(name, a = {}, db = open(), s = settings()) {
  const qvec = await embedQuery(a.query, s);
  switch (name) {
    case 'search': {
      const rows = search(db, { ...a, limit: a.limit || 20 }, qvec);
      return rows.length ? `${rows.length} result(s)${qvec ? ' (hybrid)' : ' (keyword)'}:\n${rows.map(line).join('\n')}` : 'No matching memories.';
    }
    case 'timeline': {
      const items = timeline(db, a, qvec);
      if (!items.length) return 'No anchor observation found.';
      return items.map(i =>
        i.kind === 'prompt' ? `   ${fmtDate(i.created_at)}  » user: ${i.text.slice(0, 200)}`
        : i.kind === 'summary' ? `   ${fmtDate(i.created_at)}  ≡ summary: ${i.completed || i.request}${i.next_steps ? ` | next: ${i.next_steps}` : ''}`
        : `${i.anchor ? '→' : ' '} ${line(i)}${i.anchor && i.subtitle ? `\n     ${i.subtitle}` : ''}`).join('\n');
    }
    case 'get_observations': {
      const obs = getObservations(db, a.ids || []);
      return obs.length ? obs.map(o => [
        line(o), o.subtitle, o.narrative,
        o.facts.length && `Facts:\n${o.facts.map(f => `- ${f}`).join('\n')}`,
        o.concepts.length && `Concepts: ${o.concepts.join(', ')}`,
        o.files_modified.length && `Modified: ${o.files_modified.join(', ')}`,
        o.files_read.length && `Read: ${o.files_read.join(', ')}`,
      ].filter(Boolean).join('\n')).join('\n\n---\n\n') : 'No observations with those ids.';
    }
    case 'save_memory': {
      const o = { session_id: 'manual', project: a.project || projectOf(), type: TYPES.includes(a.type) ? a.type : 'decision',
        title: redact(a.title), subtitle: '', narrative: redact(a.text), facts: [] };
      const id = insertObservation(db, o, (await embed([embedText(o)], s))?.[0]);
      return `Saved as #${id} in project "${o.project}".`;
    }
    case 'vault_search': {
      if (!s.vaultDir) return 'No Obsidian vault is linked. Link one in the open-mem GUI (Dashboard -> Obsidian vault) or set "vaultDir" in ~/.open-mem/settings.json.';
      if (!db.prepare("SELECT 1 FROM items WHERE kind = 'note' LIMIT 1").get()) await ingest(db, vaultSource(s), embed, s);   // first use
      const hits = searchItems(db, a.query, { kinds: ['note'], limit: a.limit || 10 }, qvec);
      return hits.length
        ? hits.map(n => `${n.title}  (${n.meta.path})${n.tags ? `  #${n.tags.split(' ').join(' #')}` : ''}\n  ${n.snippet.replace(/\s+/g, ' ').trim()}`).join('\n\n')
        : 'No notes match.';
    }
    case 'past_sessions': {
      if (a.id) {
        const r = getItem(db, a.id);
        if (!r || r.kind !== 'session') return `No session with id ${a.id}.`;
        return `${r.title}${gone(r)}\n${r.meta.surface} · ${when(r.started_at)} → ${when(r.updated_at)} · ${r.meta.cwd || ''}\n\n${r.body}`;
      }
      const rows = a.query
        ? searchItems(db, a.query, { kinds: ['session'], project: a.project, limit: a.limit || 15 }, qvec)
        : listItems(db, 'session', { project: a.project, limit: a.limit || 15 });
      return rows.length
        ? rows.map(r => `#${r.id}  ${when(r.started_at)}  ${r.meta.surface}  [${r.project || '?'}] ${r.title}${gone(r)}${r.snippet ? `\n     ${r.snippet.replace(/\s+/g, ' ')}` : ''}`).join('\n')
        : 'No recorded sessions match.';
    }
    case 'projects':
      return registry(db, 'project', a.name);
    case 'scheduled_tasks':
      return registry(db, 'task', a.name);
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

export function serve() {
  const db = open(), s = settings();
  const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { id, method, params } = msg;
    try {
      if (method === 'initialize') {
        return send({ id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} },
          serverInfo: { name: 'open-mem', version: VERSION } } });
      }
      if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
      if (method === 'tools/call') {
        const text = await callTool(params.name, params.arguments, db, s);
        return send({ id, result: { content: [{ type: 'text', text }] } });
      }
      if (method === 'ping') return send({ id, result: {} });
      if (id !== undefined) send({ id, error: { code: -32601, message: `method not found: ${method}` } });
    } catch (e) {
      if (method === 'tools/call') send({ id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
      else send({ id, error: { code: -32603, message: e.message } });
    }
  });
}
