// MCP stdio server (newline-delimited JSON-RPC 2.0). Progressive disclosure:
// search (cheap index) -> timeline (context) -> get_observations (full detail, only for chosen ids).
import fs from 'node:fs';
import readline from 'node:readline';
import { ingestVault, searchNotes } from './vault.mjs';
import { open, settings, search, timeline, getObservations, insertObservation, embedText, projectOf, TYPES, ICONS, fmtDate } from './db.mjs';
import { embed } from './llm.mjs';
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
];

const line = o => `#${o.id}  ${fmtDate(o.created_at)}  ${ICONS[o.type] || '•'} ${o.type.padEnd(13)} [${o.project}] ${o.title}`;

export async function callTool(name, a = {}, db = open(), s = settings()) {
  const qvec = a.query ? (await embed([a.query], s))?.[0] : null;
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
      if (!db.prepare('SELECT 1 FROM notes LIMIT 1').get()) await ingestVault(db, s, embed);   // first use: build the index
      const hits = searchNotes(db, a.query, qvec, a.limit || 10);
      return hits.length
        ? hits.map(n => `${n.title}  (${n.path.replace(/\\/g, '/')})${n.tags ? `  #${n.tags.split(' ').join(' #')}` : ''}\n  ${n.snippet.replace(/\s+/g, ' ').trim()}`).join('\n\n')
        : 'No notes match.';
    }
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
