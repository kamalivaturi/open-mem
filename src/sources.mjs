// Source adapters for the ingestion module: each lists items and parses one; ingest() does the rest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectOf } from './db.mjs';
import { redact, clip } from './redact.mjs';
import { ingest } from './ingest.mjs';

const sha1 = t => crypto.createHash('sha1').update(t).digest('hex');
const readOrNull = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const statOrNull = f => { try { return fs.statSync(f); } catch { return null; } };
const dirents = d => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };

// Where Claude Code and the Claude desktop app keep their files on this machine.
export function claudePaths(s = {}) {
  const home = s.claudeHome || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const appData = s.claudeAppData || (process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude')
      : path.join(os.homedir(), '.config', 'Claude'));
  return { home, appData };
}

// ---------- Obsidian vault: mirrors the vault (deleted notes leave), duplicate copies stored once ----------

function parseNote(file, text) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = fm?.[1] || '';
  const body = (fm ? text.slice(fm[0].length) : text).slice(0, 50_000);
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
// (so session handoffs never loop back in as duplicates) and any vaultExclude folders.
function excluded(rel, s) {
  if (rel.split(/[\\/]/).some(p => p.startsWith('.') || p === 'node_modules')) return true;
  const norm = rel.replace(/\\/g, '/').toLowerCase();
  const own = s.obsidianDir && path.relative(s.vaultDir, s.obsidianDir);
  const skip = [...(s.vaultExclude || []), ...(own && !own.startsWith('..') && !path.isAbsolute(own) ? [own] : [])];
  return skip.some(x => { const e = x.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase(); return e && (norm === e || norm.startsWith(e + '/')); });
}

function* walkVault(root, s, dir = root) {
  for (const e of dirents(dir)) {
    const full = path.join(dir, e.name), rel = path.relative(root, full);
    if (excluded(rel, s)) continue;
    if (e.isDirectory()) yield* walkVault(root, s, full);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) yield rel;
  }
}

export const vaultSource = s => ({
  name: 'vault', kind: 'note', dedup: true,
  *list() {
    if (!s.vaultDir) return;
    for (const rel of walkVault(s.vaultDir, s)) {
      const full = path.join(s.vaultDir, rel), st = statOrNull(full);
      if (st) yield { key: rel, stamp: Math.floor(st.mtimeMs), load: () => readOrNull(full) };
    }
  },
  parse: (item, text) => ({ ...parseNote(item.key, text), meta: { path: item.key.replace(/\\/g, '/') } }),
});

// ---------- Claude Code + Claude Desktop (Code tab) sessions: an archive that outlives Claude's cleanup ----------

const SURFACES = { 'claude-desktop': 'Claude Desktop', cli: 'Claude Code CLI', 'sdk-ts': 'Agent SDK', 'sdk-py': 'Agent SDK' };

// Text a person or Claude actually wrote: drop injected reminders, local-command caveats and tag wrappers.
function readable(t) {
  if (/^Caveat: The messages below were generated/.test(t)) return '';
  return t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<\/?(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr)>/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
}

export function parseTranscript(sessionId, text, desktop = new Map()) {
  let cwd, branch, entry, first, last, custom, prompts = 0, human = false;
  const parts = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'custom-title' && o.customTitle) custom = o.customTitle;
    if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || o.isMeta) continue;
    cwd ??= o.cwd; branch ??= o.gitBranch; entry ??= o.entrypoint;
    if (o.origin?.kind === 'human') human = true;
    const ts = Date.parse(o.timestamp);
    if (ts) { first ??= ts; last = ts; }
    const c = o.message?.content;
    const said = readable(typeof c === 'string' ? c : Array.isArray(c) ? c.filter(p => p.type === 'text').map(p => p.text).join('\n') : '');
    if (!said) continue;
    if (o.type === 'user') prompts++;
    parts.push(o.type === 'user' ? `User: ${clip(said, 1500)}` : `Claude: ${clip(said, 800)}`);
  }
  const desk = desktop.get(sessionId);
  if (!prompts) return null;
  const meta = { sessionId, cwd, gitBranch: branch, surface: SURFACES[entry] || entry || 'Claude Code', prompts, model: desk?.model };
  // Background runs (the desktop app's own summarizing calls, SDK one-shots, `claude -p` helpers) are a
  // single untitled prompt nobody typed; on real data that was 54 of 91 transcripts. Keep only where they
  // ran (evidence of a project folder), never their text, and never list them as sessions.
  if (!human && prompts === 1 && !custom && !desk) {
    return { kind: 'background', title: 'Background run', body: '', project: cwd ? projectOf(cwd) : null, started_at: first || null, updated_at: last || null, meta };
  }
  const firstPrompt = parts.find(p => p.startsWith('User: ')).slice(6).replace(/\s+/g, ' ');
  return {
    title: custom || desk?.title || clip(firstPrompt, 90),
    body: clip(redact(parts.join('\n\n')), 40_000),
    project: cwd ? projectOf(cwd) : null,
    started_at: first || null, updated_at: last || null,
    meta,
  };
}

// Desktop keeps a title and model per session, keyed by the CLI session id.
function desktopSessions(appData) {
  const map = new Map();
  for (const org of dirents(path.join(appData, 'claude-code-sessions'))) {
    for (const acct of dirents(path.join(appData, 'claude-code-sessions', org.name))) {
      const dir = path.join(appData, 'claude-code-sessions', org.name, acct.name);
      for (const f of dirents(dir)) {
        if (!/^local_.*\.json$/.test(f.name)) continue;
        try { const j = JSON.parse(fs.readFileSync(path.join(dir, f.name), 'utf8')); if (j.cliSessionId) map.set(j.cliSessionId, { title: j.title, model: j.model }); } catch {}
      }
    }
  }
  return map;
}

export function transcriptSource(s) {
  const { home, appData } = claudePaths(s);
  let desktop = null;
  return {
    name: 'claude-transcripts', kind: 'session', retain: true,
    *list() {
      const root = path.join(home, 'projects');
      for (const dir of dirents(root)) {
        if (!dir.isDirectory()) continue;
        for (const f of dirents(path.join(root, dir.name))) {
          if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;   // subagent transcripts sit in subfolders
          const full = path.join(root, dir.name, f.name), st = statOrNull(full);
          // ponytail: whole-file read of changed transcripts (largest here ~100 MB); stream by line if that hurts.
          if (st) yield { key: f.name.slice(0, -6), stamp: Math.floor(st.mtimeMs), load: () => readOrNull(full) };
        }
      }
    },
    parse: (item, text) => parseTranscript(item.key, text, (desktop ??= desktopSessions(appData))),
  };
}

// ---------- Scheduled tasks (Claude Desktop + Cowork): a registry that remembers deleted tasks ----------

function* scheduledTaskFiles(appData) {
  for (const [area, surface] of [['claude-code-sessions', 'Claude Desktop'], ['local-agent-mode-sessions', 'Claude Cowork']]) {
    for (const org of dirents(path.join(appData, area))) {
      for (const acct of dirents(path.join(appData, area, org.name))) {
        const f = path.join(appData, area, org.name, acct.name, 'scheduled-tasks.json');
        if (statOrNull(f)) yield { file: f, surface };
      }
    }
  }
}

export function scheduledTaskSource(s) {
  const { home, appData } = claudePaths(s);
  return {
    name: 'claude-scheduled-tasks', kind: 'task', retain: true,
    *list() {
      for (const { file, surface } of scheduledTaskFiles(appData)) {
        let tasks = [];
        try { tasks = JSON.parse(fs.readFileSync(file, 'utf8')).scheduledTasks || []; } catch { continue; }
        for (const t of tasks) {
          const id = t.taskId ?? t.id ?? t.name ?? t.title;
          if (!id) continue;
          const promptFile = [t.path, t.skillPath, t.promptPath, path.join(home, 'scheduled-tasks', String(id), 'SKILL.md')]
            .find(p => p && statOrNull(p)?.isFile());
          const json = JSON.stringify(t);
          yield {
            key: `${surface}:${id}`, surface, task: t, promptFile,
            stamp: sha1(json) + (promptFile ? `:${Math.floor(statOrNull(promptFile).mtimeMs)}` : ''),
            load: () => `${json}\n${promptFile ? readOrNull(promptFile) || '' : ''}`,
          };
        }
      }
    },
    parse(item, text) {
      const t = item.task;
      const schedule = t.schedule ?? t.cronExpression ?? t.cron ?? (t.fireAt ? `once at ${t.fireAt}` : '');
      const prompt = text.slice(text.indexOf('\n') + 1).trim();
      return {
        title: t.title || t.name || String(t.taskId ?? t.id),
        body: redact([t.description, schedule && `Schedule: ${schedule}`, prompt && `Prompt:\n${clip(prompt, 8000)}`].filter(Boolean).join('\n\n')),
        updated_at: Date.parse(t.updatedAt || t.lastRunAt || '') || null,
        meta: { surface: item.surface, taskId: t.taskId ?? t.id, schedule, enabled: t.enabled !== false,
          nextRunAt: t.nextRunAt || null, lastRunAt: t.lastRunAt || null, promptFile: item.promptFile || null },
      };
    },
  };
}

// ---------- Projects: every folder Claude has worked in that looks like a project ----------

const PROJECT_FILES = ['README.md', 'CLAUDE.md', 'AGENTS.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];

// Home, drive roots and (unless projectIgnoreTemp is off) temp/scratch/app-data folders are never projects.
function projectRoot(cwd, ignoreTemp = true) {
  if (!cwd) return null;
  const p = path.resolve(cwd);
  const home = path.resolve(os.homedir()).toLowerCase(), tmp = path.resolve(os.tmpdir()).toLowerCase();
  const skip = q => {
    const l = q.toLowerCase();
    return l === home || path.dirname(q) === q || (ignoreTemp && (l.startsWith(tmp) || /[\\/](appdata|scratch-workspaces|\.claude)([\\/]|$)/i.test(q)));
  };
  for (let q = p; !skip(q); q = path.dirname(q)) if (statOrNull(path.join(q, '.git'))) return q;
  return !skip(p) && PROJECT_FILES.some(f => statOrNull(path.join(p, f))) ? p : null;
}

function gitRemote(root) {
  return readOrNull(path.join(root, '.git', 'config'))?.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1] || null;
}

function projectMaterial(root, files) {
  const out = [`# ${path.basename(root)}`, `Path: ${root}`];
  const remote = gitRemote(root);
  if (remote) out.push(`Remote: ${remote.replace(/\/\/[^@/]+@/, '//')}`);
  for (const f of files) {
    const text = readOrNull(path.join(root, f));
    if (!text) continue;
    if (f === 'package.json') {
      try { const j = JSON.parse(text); out.push(`## package.json\nname: ${j.name || ''}\ndescription: ${j.description || ''}\nscripts: ${Object.keys(j.scripts || {}).join(', ')}`); } catch {}
    } else out.push(`## ${f}\n${clip(text, f === 'README.md' ? 4000 : 2500)}`);
  }
  return redact(out.join('\n\n'));
}

export function projectSource(db, s = {}) {
  return {
    name: 'projects', kind: 'project', retain: true,
    *list() {
      const cwds = [
        ...db.prepare("SELECT DISTINCT cwd FROM sessions WHERE cwd != ''").all().map(r => r.cwd),
        ...db.prepare("SELECT DISTINCT json_extract(meta, '$.cwd') cwd FROM items WHERE kind IN ('session', 'background')").all().map(r => r.cwd),
      ];
      const roots = new Map();
      for (const cwd of cwds) { const r = projectRoot(cwd, s.projectIgnoreTemp !== false); if (r) roots.set(r.toLowerCase(), r); }
      for (const root of roots.values()) {
        const files = PROJECT_FILES.filter(f => statOrNull(path.join(root, f)));
        yield { key: root, root, files, stamp: files.map(f => Math.floor(statOrNull(path.join(root, f)).mtimeMs)).join('.') || 'none',
          load: () => projectMaterial(root, files) };
      }
    },
    parse: (item, text) => ({ title: path.basename(item.root), body: text, project: projectOf(item.root), meta: { path: item.root, remote: gitRemote(item.root), files: item.files } }),
  };
}

// ---------- claude.ai / Claude Desktop chat: conversations.json from Settings -> Privacy -> Export data ----------

export function chatExportSource(file) {
  return {
    name: 'claude-ai-chats', kind: 'session', retain: true,
    *list() {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const c of Array.isArray(data) ? data : data.conversations || []) {
        if (!c?.uuid) continue;
        const json = JSON.stringify(c);
        yield { key: c.uuid, conv: c, stamp: c.updated_at || sha1(json), load: () => json };
      }
    },
    parse(item) {
      const c = item.conv;
      const msgs = (c.chat_messages || []).map(m => ({
        who: m.sender === 'human' ? 'User' : 'Claude',
        text: m.text || (m.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n'),
      })).filter(m => m.text?.trim());
      if (!msgs.length) return null;
      return {
        title: c.name || clip(msgs[0].text.replace(/\s+/g, ' '), 90),
        body: clip(redact(msgs.map(m => `${m.who}: ${clip(m.text, m.who === 'User' ? 1500 : 800)}`).join('\n\n')), 40_000),
        started_at: Date.parse(c.created_at) || null, updated_at: Date.parse(c.updated_at) || null,
        meta: { surface: 'claude.ai', messages: msgs.length, conversationId: c.uuid },
      };
    },
  };
}

// Everything switched on in settings, in dependency order (projects come from the sessions found first).
export async function ingestAll(db, s, embed = null) {
  const sources = [
    s.vaultDir && vaultSource(s),
    s.recordClaudeHistory && transcriptSource(s),
    s.recordScheduledTasks && scheduledTaskSource(s),
    s.recordProjects && projectSource(db, s),
  ].filter(Boolean);
  const out = {};
  for (const src of sources) {
    try { out[src.name] = await ingest(db, src, embed, s); } catch (e) { out[src.name] = { error: e.message }; }
  }
  return out;
}
