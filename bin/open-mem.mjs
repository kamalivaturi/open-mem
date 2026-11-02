#!/usr/bin/env node
// open-mem CLI. Claude Code calls `hook` (hooks.json) and `mcp` (.mcp.json); the rest are for you.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, open, settings, search, fmtDate, ICONS } from '../src/db.mjs';

const [cmd = 'help', ...args] = process.argv.slice(2);
const flag = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? true : undefined; };
const positional = () => args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));

async function readStdin() {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

const commands = {
  async hook() {
    // A hook must never break Claude: log failures and exit 0.
    try {
      const { handleHook } = await import('../src/hooks.mjs');
      const out = handleHook(JSON.parse((await readStdin()) || '{}'));
      if (out) process.stdout.write(out);
    } catch (e) {
      try { fs.mkdirSync(HOME, { recursive: true }); fs.appendFileSync(path.join(HOME, 'open-mem.log'), `${new Date().toISOString()} hook error: ${e.stack}\n`); } catch {}
    }
  },

  async drain() {
    const { drain, withLock } = await import('../src/observer.mjs');
    const r = await withLock(() => drain(open(), settings()));
    console.log(r ? JSON.stringify(r) : 'another drain is already running');
  },

  async mcp() {
    (await import('../src/mcp.mjs')).serve();
  },

  async viewer() {
    const { serveViewer } = await import('../src/viewer.mjs');
    serveViewer(Number(flag('port')) || settings().viewerPort);
  },

  async search() {
    const { embed } = await import('../src/llm.mjs');
    const query = positional().join(' ');
    const s = settings();
    const vec = query ? (await embed([query], s))?.[0] : null;
    const rows = search(open(), { query, project: flag('project'), type: flag('type'), limit: Number(flag('limit')) || 20 }, vec);
    if (!rows.length) return console.log('No matching memories.');
    for (const o of rows) console.log(`#${o.id}  ${fmtDate(o.created_at)}  ${ICONS[o.type] || '•'} ${o.type.padEnd(13)} [${o.project}] ${o.title}`);
  },

  async status() {
    const db = open(), s = settings();
    const n = sql => db.prepare(sql).get().n;
    console.log(`open-mem home   ${HOME}
observer       ${s.provider} (${s.provider === 'claude' ? s.claudeModel : s.model})
embeddings     ${s.embedModel || 'off'}
obsidian       ${s.obsidianDir || 'off'}   vault search: ${s.vaultDir || 'off'}
memories       ${n('SELECT COUNT(*) n FROM observations')}
sessions       ${n('SELECT COUNT(*) n FROM sessions')} (${n('SELECT COUNT(*) n FROM summaries')} summarized)
queue          ${n('SELECT COUNT(*) n FROM events WHERE done = 0')} pending tool calls
drain running  ${fs.existsSync(path.join(HOME, 'drain.lock')) ? 'yes' : 'no'}`);
  },

  async 'ingest-vault'() {
    const s = settings();
    if (flag('dir')) s.vaultDir = path.resolve(flag('dir'));
    if (!s.vaultDir) return console.log('Link a vault in the GUI, set vaultDir in settings, or pass --dir <vault>.');
    const { ingestVault, watchVault } = await import('../src/vault.mjs');
    const { embed } = await import('../src/llm.mjs');
    const db = open();
    const r = await ingestVault(db, s, embed);
    console.log(`${s.vaultDir}: ${r.scanned} notes scanned, ${r.added} added, ${r.updated} updated, ${r.removed} removed, ${r.duplicates} duplicates skipped`);
    if (flag('watch')) {
      console.log('Watching for changes (Ctrl+C to stop)…');
      watchVault(db, s, embed, x => x.error ? console.error(x.error) : (x.added || x.updated || x.removed) &&
        console.log(`${new Date().toLocaleTimeString()} +${x.added} ~${x.updated} -${x.removed}`));
    }
  },

  async 'export-obsidian'() {
    const dir = flag('dir') || settings().obsidianDir;
    if (!dir) return console.log('Set obsidianDir in settings or pass --dir <folder>.');
    const { exportObsidian } = await import('../src/observer.mjs');
    const { getObservations } = await import('../src/db.mjs');
    const db = open();
    const rows = db.prepare('SELECT s.*, x.started_at FROM summaries s JOIN sessions x ON x.id = s.session_id').all();
    for (const r of rows) {
      const ids = db.prepare('SELECT id FROM observations WHERE session_id = ?').all(r.session_id).map(x => x.id);
      exportObsidian(db, dir, { id: r.session_id, project: r.project, started_at: r.started_at }, r, getObservations(db, ids));
    }
    console.log(`Exported ${rows.length} session note(s) to ${dir}`);
  },

  help() {
    console.log(`open-mem — free, local, long-term memory for Claude Code

  open-mem viewer [--port 37778]       web GUI at http://127.0.0.1:37778
  open-mem search <query> [--project p] [--type t] [--limit n]
  open-mem status                      counts, queue and configuration
  open-mem drain                       process queued tool calls now
  open-mem ingest-vault [--dir v] [--watch]  index an Obsidian vault as memory (and keep watching)
  open-mem export-obsidian [--dir d]   write all session notes to an Obsidian folder
  open-mem mcp                         MCP server (started by Claude Code)
  open-mem hook                        hook handler (called by Claude Code)

Settings: ${path.join(HOME, 'settings.json')}`);
  },
};

await (commands[cmd] || commands.help)();
