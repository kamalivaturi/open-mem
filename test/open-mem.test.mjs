// End-to-end checks with a fake observer model. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'open-mem-test-'));
process.env.OPEN_MEM_HOME = TMP;
process.env.OPEN_MEM_NO_SPAWN = '1';
// Point open-mem at fixture copies of Claude's folders so tests never read the real ones.
const CLAUDE_HOME = path.join(TMP, 'claude-home'), CLAUDE_APPDATA = path.join(TMP, 'claude-appdata');
fs.writeFileSync(path.join(TMP, 'settings.json'), JSON.stringify({ claudeHome: CLAUDE_HOME, claudeAppData: CLAUDE_APPDATA, projectIgnoreTemp: false }));
const BIN = fileURLToPath(new URL('../bin/open-mem.mjs', import.meta.url));

const { open, settings, search, timeline, getObservations } = await import('../src/db.mjs');
const { redact } = await import('../src/redact.mjs');
const { handleHook } = await import('../src/hooks.mjs');
const { drain, parseObservations, parseSummary } = await import('../src/observer.mjs');
const { createServer } = await import('../src/viewer.mjs');

const OBS_XML = `<observation><type>bugfix</type><title>Fixed login redirect loop</title>
<subtitle>Session cookie lacked SameSite=Lax</subtitle><facts><fact>auth.ts sets the cookie</fact><fact>Lax &amp; Secure required</fact></facts>
<narrative>Users bounced between /login and /home.</narrative><concepts><concept>problem-solution</concept></concepts>
<files_read><file>src/auth.ts</file></files_read><files_modified><file>src/auth.ts</file></files_modified></observation>`;
const SUM_XML = '<summary><request>Fix login loop</request><investigated>cookies</investigated><learned>SameSite matters</learned><completed>Cookie fixed</completed><next_steps>Add e2e test</next_steps><notes></notes></summary>';

// Fake model: observation prompts get OBS_XML, summary prompts get SUM_XML. Embeddings: tiny bag-of-letters vectors.
const fake = {
  complete: async p => (p.includes('<purpose>') ? '<purpose>Purpose: a demo web shop.</purpose>' : p.includes('<summary>') ? SUM_XML : OBS_XML),
  embed: async texts => texts.map(t => Array.from({ length: 26 }, (_, i) => (t.toLowerCase().split(String.fromCharCode(97 + i)).length - 1))),
};

test('redact removes secrets and private blocks', () => {
  const s = redact('key sk-ant-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwxyz0123456789 password=hunter22 <private>my diary</private> https://bob:pw123@host.com AKIAABCDEFGHIJKLMNOP');
  for (const leaked of ['sk-ant-abc', 'ghp_abc', 'hunter22', 'my diary', 'pw123', 'AKIAABCD']) assert.ok(!s.includes(leaked), `${leaked} leaked: ${s}`);
  assert.equal(redact('max_tokens: 1000, author: Alex'), 'max_tokens: 1000, author: Alex');
});

test('parsers read observer XML', () => {
  const [o] = parseObservations(`noise ${OBS_XML} <observation><title></title></observation>`);
  assert.equal(o.type, 'bugfix');
  assert.deepEqual(o.facts, ['auth.ts sets the cookie', 'Lax & Secure required']);
  assert.deepEqual(o.files_modified, ['src/auth.ts']);
  assert.equal(parseObservations('<none/>').length, 0);
  assert.equal(parseSummary(SUM_XML).next_steps, 'Add e2e test');
  assert.equal(parseObservations('<observation><type>weird</type><title>T</title></observation>')[0].type, 'change');
});

test('hooks -> drain -> search -> timeline -> context -> obsidian', async () => {
  const db = open();
  const vault = path.join(TMP, 'vault');
  const s = { ...settings(), batchSize: 2, obsidianDir: vault };
  const cwd = path.join(TMP, 'demo');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  const base = { session_id: 'sess-0001-abcd', cwd };

  assert.equal(handleHook({ ...base, hook_event_name: 'SessionStart' }, s, db), '');
  handleHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'fix the login loop, token=supersecret123' }, s, db);
  handleHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'src/auth.ts' }, tool_response: 'cookie code' }, s, db);
  handleHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/auth.ts' }, tool_response: 'ok' }, s, db);
  handleHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_input: {}, tool_response: '' }, s, db);
  handleHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'mcp__plugin_open-mem_open-mem__search', tool_input: {}, tool_response: '' }, s, db);
  handleHook({ ...base, hook_event_name: 'Stop' }, s, db);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 2, 'skipped tools are not recorded');
  assert.ok(!db.prepare('SELECT text FROM prompts').get().text.includes('supersecret123'), 'prompt redacted');

  const stats = await drain(db, s, fake);
  assert.equal(stats.observations, 1);
  assert.equal(stats.summaries, 1);
  assert.equal(stats.described, 1, "demo project gets a purpose");

  // Same finding again is deduplicated.
  handleHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'pass' }, s, db);
  assert.equal((await drain(db, s, fake)).observations, 0);

  const [hit] = search(db, { query: 'login redirect' });
  assert.equal(hit.title, 'Fixed login redirect loop');
  assert.equal(search(db, { query: 'login', project: 'nope' }).length, 0);
  assert.equal(search(db, { query: 'xyzzy' }, (await fake.embed(['login redirect loop']))[0]).length, 1, 'semantic match without keyword hit');

  const tl = timeline(db, { id: hit.id });
  assert.ok(tl.some(i => i.kind === 'summary') && tl.some(i => i.anchor));
  assert.equal(getObservations(db, [hit.id])[0].facts.length, 2);

  const ctx = handleHook({ ...base, session_id: 'sess-0002', hook_event_name: 'SessionStart' }, s, db);
  assert.match(ctx, /Fixed login redirect loop/);
  assert.match(ctx, /Next steps:\*\* Add e2e test/);
  assert.match(ctx, /## About this project\nPurpose: a demo web shop\./);

  const notes = fs.readdirSync(path.join(vault, 'demo'));
  assert.ok(notes.includes('demo.md'), 'project index note');
  const note = fs.readFileSync(path.join(vault, 'demo', notes.find(n => n !== 'demo.md')), 'utf8');
  assert.match(note, /tags: \[open-mem\]/);
  assert.match(note, /\[\[demo\]\]/);
});

test('vault ingest: incremental, deduplicated, exclusions, deletions, context', async () => {
  const { ingest, searchItems } = await import('../src/ingest.mjs'); const { vaultSource } = await import('../src/sources.mjs');
  const ingestVault = (db, s) => ingest(db, vaultSource(s), null, s);
  const searchNotes = (db, q) => searchItems(db, q, { kinds: ['note'] });
  const db = open();
  const vault = path.join(TMP, 'MyVault');
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); fs.writeFileSync(path.join(vault, rel), text); };
  w('Cooking.md', '---\ntags: [food, italian]\n---\n# Pasta carbonara\nUse guanciale, never cream.');
  w('Copy of Cooking.md', '---\ntags: [food, italian]\n---\n# Pasta carbonara\nUse guanciale, never cream.');
  w('Projects/demo plan.md', '# Demo roadmap\nThe demo project ships the login fix first. #planning');
  w('journal/2026-11-01.md', 'private diary about demo');
  w('.obsidian/workspace.md', 'app state');
  w('claude/open-mem/demo/2026-11-02 abc.md', 'open-mem own export about demo');
  const s = { ...settings(), vaultDir: vault, vaultExclude: ['journal'], obsidianDir: path.join(vault, 'claude', 'open-mem') };

  const first = await ingestVault(db, s);
  assert.deepEqual(first, { scanned: 3, added: 2, updated: 0, removed: 0, duplicates: 1 });
  assert.deepEqual(await ingestVault(db, s), { scanned: 3, added: 0, updated: 0, removed: 0, duplicates: 1 }, 'nothing re-indexed');

  const [hit] = searchNotes(db, 'guanciale');
  assert.equal(hit.title, 'Pasta carbonara');
  assert.match(hit.tags, /italian/);
  assert.equal(searchNotes(db, 'diary').length, 0, 'excluded folder never indexed');
  assert.equal(searchNotes(db, 'own export').length, 0, 'open-mem export not re-ingested');

  const later = new Date(Date.now() + 5000);
  w('Projects/demo plan.md', '# Demo roadmap\nThe demo project now ships checkout locks too.');
  fs.utimesSync(path.join(vault, 'Projects/demo plan.md'), later, later);
  fs.rmSync(path.join(vault, 'Copy of Cooking.md'));
  fs.rmSync(path.join(vault, 'Cooking.md'));
  const third = await ingestVault(db, s);
  assert.equal(third.updated, 1);
  assert.equal(third.removed, 1);
  assert.equal(searchNotes(db, 'checkout locks')[0].title, 'Demo roadmap');
  assert.equal(searchNotes(db, 'guanciale').length, 0, 'deleted note leaves the index');

  const ctx = handleHook({ session_id: 'sess-vault', cwd: path.join(TMP, 'demo'), hook_event_name: 'SessionStart' }, s, db);
  assert.match(ctx, /Related notes in your Obsidian vault[\s\S]*Demo roadmap \(Projects\/demo plan\.md\)/);
});

test('regressions from code review', async () => {
  const { withLock } = await import('../src/observer.mjs');
  // drain on a fresh install (data folder missing) must not recurse forever
  const fresh = spawn(process.execPath, ['--no-warnings', BIN, 'drain'], { env: { ...process.env, OPEN_MEM_HOME: path.join(TMP, 'fresh-home'), CLAUDE_CONFIG_DIR: CLAUDE_HOME, APPDATA: CLAUDE_APPDATA } });
  let out = '';
  fresh.stdout.on('data', d => (out += d)); fresh.stderr.on('data', d => (out += d));
  assert.equal(await new Promise(r => fresh.on('close', r)), 0, out);
  assert.equal(await withLock(async () => 'ran'), 'ran');

  // tool output is redacted before clipping, so a key at the clip boundary can't leak in part
  const db = open(), s = { ...settings(), batchSize: 99, recordProjects: false };
  const key = 'sk-ant-' + 'x'.repeat(40);
  handleHook({ session_id: 'sess-clip', cwd: TMP, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: `${'a'.repeat(2068)} ANTHROPIC_KEY=${key} ${'b'.repeat(2000)}` }, s, db);   // clip cuts 17 chars into the key
  assert.ok(!db.prepare("SELECT output FROM events WHERE session_id = 'sess-clip'").get().output.includes('sk-ant-x'));

  // a prompt-only turn does not trigger another summary call
  let calls = 0;
  const counting = { complete: async p => (calls++, p.includes('<summary>') ? '<summary><request>r</request></summary>' : '<none/>'), embed: async () => null };
  db.prepare("UPDATE events SET done = 1 WHERE session_id = 'sess-clip'").run();
  db.prepare("UPDATE sessions SET summarize_at = ? WHERE id = 'sess-0001-abcd'").run(Date.now() + 1000);
  handleHook({ session_id: 'sess-0001-abcd', cwd: path.join(TMP, 'demo'), hook_event_name: 'UserPromptSubmit', prompt: 'thanks!' }, s, db);
  await drain(db, s, counting);
  assert.equal(calls, 0, 'no new observations -> no new summary');

  // only the tags: key becomes tags; numeric settings accept 0; unlinking a vault stops the export into it
  const { ingest, searchItems } = await import('../src/ingest.mjs'); const { vaultSource } = await import('../src/sources.mjs');
  const ingestVault = (db, s) => ingest(db, vaultSource(s), null, s);
  const searchNotes = (db, q) => searchItems(db, q, { kinds: ['note'] });
  const v = path.join(TMP, 'TagVault');
  fs.mkdirSync(v, { recursive: true });
  fs.writeFileSync(path.join(v, 'n.md'), '---\naliases:\n  - Old name\ntags:\n  - alpha\n  - beta\n---\n# Tagged note\nbody');
  await ingestVault(db, { ...s, vaultDir: v, obsidianDir: null });
  assert.equal(searchNotes(db, 'Tagged')[0].tags, 'alpha beta');

  const srv = createServer(db);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`, H = { 'x-open-mem': '1' };
  try {
    const saved = await (await fetch(`${base}/api/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ contextNotes: 0 }) })).json();
    assert.equal(saved.contextNotes, 0);
    await fetch(`${base}/api/vault`, { method: 'POST', headers: H, body: JSON.stringify({ vaultDir: v, exportNotes: true }) });
    await fetch(`${base}/api/vault`, { method: 'DELETE', headers: H });
    const after = settings();
    assert.equal(after.vaultDir, null);
    assert.equal(after.obsidianDir, null, 'export into the unlinked vault stops');
  } finally {
    srv.close();
  }
});

test('sources: Claude transcripts, scheduled tasks, projects, chat export', async () => {
  const { ingest, listItems, searchItems } = await import('../src/ingest.mjs');
  const { transcriptSource, scheduledTaskSource, projectSource, chatExportSource } = await import('../src/sources.mjs');
  const { callTool } = await import('../src/mcp.mjs');
  const db = open(), s = settings();
  const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const line = o => JSON.stringify(o);
  const demo = path.join(TMP, 'demo');
  put(path.join(demo, 'README.md'), '# Demo shop\nA small web shop used to try checkout ideas.');

  // Two sessions: one titled in-transcript, one titled only by Claude Desktop. Sidechain + meta lines are ignored.
  const t1 = path.join(CLAUDE_HOME, 'projects', 'C--demo', 'aaaa-1111.jsonl');
  put(t1, [
    line({ type: 'user', isMeta: true, message: { content: 'Caveat: The messages below were generated by the user while running local commands.' } }),
    line({ type: 'user', sessionId: 'aaaa-1111', cwd: demo, entrypoint: 'claude-desktop', gitBranch: 'main', timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: 'Fix the CSV export, my password=hunter22 is in the env' } }),
    line({ type: 'assistant', timestamp: '2026-10-01T10:05:00Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret plan' }, { type: 'text', text: 'Fixed quoting in toCsv.' }] } }),
    line({ type: 'user', isSidechain: true, timestamp: '2026-10-01T10:06:00Z', message: { content: 'subagent chatter' } }),
    line({ type: 'custom-title', customTitle: 'CSV export fix', sessionId: 'aaaa-1111' }),
  ].join('\n'));
  put(path.join(CLAUDE_HOME, 'projects', 'C--demo', 'bbbb-2222.jsonl'),
    line({ type: 'user', sessionId: 'bbbb-2222', cwd: demo, entrypoint: 'cli', timestamp: '2026-10-02T09:00:00Z', message: { content: [{ type: 'text', text: 'Plan the checkout locks' }] } }));
  put(path.join(CLAUDE_HOME, 'projects', 'C--demo', 'aaaa-1111', 'subagents', 'agent-x.jsonl'), line({ type: 'user', message: { content: 'nested' } }));
  put(path.join(CLAUDE_HOME, 'projects', 'C--demo', 'cccc-auto.jsonl'),   // a background run: one untitled prompt nobody typed
    line({ type: 'user', sessionId: 'cccc-auto', cwd: demo, entrypoint: 'claude-desktop', timestamp: '2026-10-03T09:00:00Z', message: { content: 'Below is a conversation log. Summarize it.' } }));
  put(path.join(CLAUDE_APPDATA, 'claude-code-sessions', 'org', 'acct', 'local_1.json'), line({ cliSessionId: 'bbbb-2222', title: 'Checkout locks plan', model: 'claude-opus-5-5' }));

  const r1 = await ingest(db, transcriptSource(s), null, s);
  assert.equal(r1.added, 3, JSON.stringify(r1));   // two sessions + one background record
  const sessions = listItems(db, 'session');
  assert.equal(sessions.length, 2, 'the background run is not a session');
  assert.equal(listItems(db, 'background')[0].excerpt, '', 'background runs keep no text');
  const csv = sessions.find(x => x.title === 'CSV export fix');
  assert.ok(csv && sessions.some(x => x.title === 'Checkout locks plan'), 'custom title, then Desktop title');
  assert.equal(csv.meta.surface, 'Claude Desktop');
  assert.equal(csv.project, 'demo');
  const body = (await import('../src/ingest.mjs')).getItem(db, csv.id).body;
  assert.ok(!body.includes('hunter22') && !body.includes('secret plan') && !body.includes('subagent chatter') && body.includes('Fixed quoting'));
  assert.equal(sessions.find(x => x.title === 'Checkout locks plan').meta.surface, 'Claude Code CLI');

  fs.rmSync(t1);   // Claude Code cleaned it up: open-mem keeps it, marked missing
  const r2 = await ingest(db, transcriptSource(s), null, s);
  assert.equal(r2.removed, 1);
  assert.ok(listItems(db, 'session').find(x => x.title === 'CSV export fix').missing_at);

  // Scheduled task (Cowork) with its prompt file; deleting it keeps a marked record.
  const tasksFile = path.join(CLAUDE_APPDATA, 'local-agent-mode-sessions', 'org', 'acct', 'scheduled-tasks.json');
  put(tasksFile, line({ scheduledTasks: [{ taskId: 'daily-ux', title: 'Daily UX deep-dive', description: 'Teach one UX topic a day', cronExpression: '0 8 * * *', enabled: true }] }));
  put(path.join(CLAUDE_HOME, 'scheduled-tasks', 'daily-ux', 'SKILL.md'), 'Research one UX topic and write a lesson into the vault.');
  assert.equal((await ingest(db, scheduledTaskSource(s), null, s)).added, 1);
  const [task] = listItems(db, 'task');
  assert.equal(task.meta.surface, 'Claude Cowork');
  assert.equal(task.meta.schedule, '0 8 * * *');
  assert.match(searchItems(db, 'lesson vault', { kinds: ['task'] })[0].title, /Daily UX/);
  put(tasksFile, line({ scheduledTasks: [] }));
  await ingest(db, scheduledTaskSource(s), null, s);
  assert.ok(listItems(db, 'task')[0].missing_at, 'deleted task stays in the registry, marked');

  // Projects come from the folders sessions ran in; the README becomes the material for its purpose.
  await ingest(db, projectSource(db, s), null, s);
  const proj = listItems(db, 'project').find(p => p.title === 'demo');
  assert.ok(proj, 'demo project registered');
  assert.match((await import('../src/ingest.mjs')).getItem(db, proj.id).body, /small web shop/);

  // claude.ai export
  const exp = path.join(TMP, 'conversations.json');
  put(exp, JSON.stringify([{ uuid: 'c-1', name: 'Trip ideas', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z',
    chat_messages: [{ sender: 'human', text: 'Plan a weekend in Kyoto' }, { sender: 'assistant', text: 'Day 1: Fushimi Inari.' }] }]));
  assert.equal((await ingest(db, chatExportSource(exp), null, s)).added, 1);
  assert.equal(searchItems(db, 'Kyoto', { kinds: ['session'] })[0].meta.surface, 'claude.ai');

  // Claude sees all of it through MCP
  assert.match(await callTool('past_sessions', { query: 'checkout locks' }, db, s), /Checkout locks plan/);
  assert.match(await callTool('scheduled_tasks', {}, db, s), /Daily UX deep-dive.*deleted at source/);
  assert.match(await callTool('projects', { name: 'demo' }, db, s), /small web shop/);
});

test('MCP server speaks JSON-RPC over stdio', async () => {
  const p = spawn(process.execPath, ['--no-warnings', BIN, 'mcp'], { env: { ...process.env, OPEN_MEM_HOME: TMP } });
  const replies = [];
  let buf = '';
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = m => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  send({ id: 3, method: 'tools/call', params: { name: 'search', arguments: { query: 'login' } } });
  send({ id: 4, method: 'tools/call', params: { name: 'save_memory', arguments: { title: 'Prefer pnpm', text: 'User prefers pnpm' } } });
  send({ id: 5, method: 'nope' });
  for (let t = 0; replies.length < 5 && t < 100; t++) await new Promise(r => setTimeout(r, 50));
  p.kill();
  const byId = Object.fromEntries(replies.map(r => [r.id, r]));
  assert.equal(byId[1].result.serverInfo.name, 'open-mem');
  assert.deepEqual(byId[2].result.tools.map(t => t.name), ['search', 'timeline', 'get_observations', 'save_memory', 'vault_search', 'past_sessions', 'projects', 'scheduled_tasks']);
  assert.match(byId[3].result.content[0].text, /Fixed login redirect loop/);
  assert.match(byId[4].result.content[0].text, /Saved as #\d+/);
  assert.equal(byId[5].error.code, -32601);
});

test('viewer API serves data and blocks cross-site writes', async () => {
  const srv = createServer(open());
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.match(await (await fetch(base)).text(), /<title>open-mem<\/title>/);
    const st = await (await fetch(`${base}/api/stats`)).json();
    assert.ok(st.observations >= 1 && st.daily.length === 30);
    const { results } = await (await fetch(`${base}/api/search?q=login`)).json();
    const id = results[0].id;
    assert.equal((await fetch(`${base}/api/observations/${id}`, { method: 'DELETE' })).status, 403, 'no header -> blocked');
    const rebind = await new Promise(r => http.get(`${base}/api/stats`, { headers: { host: 'evil.example' } }, res => { res.resume(); r(res.statusCode); }));
    assert.equal(rebind, 403, 'DNS rebinding -> blocked');
    assert.equal((await fetch(`${base}/api/sessions`)).status, 200);
    const put = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'x-open-mem': '1' }, body: JSON.stringify({ batchSize: '5', bogus: 1, openaiApiKey: 'sk-test-123' }) });
    const saved = await put.json();
    assert.equal(saved.batchSize, 5);
    assert.equal(saved.bogus, undefined);
    assert.equal(saved.openaiApiKey, '••••••••', 'api key never returned');
    assert.equal((await fetch(`${base}/api/observations/${id}`, { method: 'DELETE', headers: { 'x-open-mem': '1' } })).status, 200);
    assert.equal((await fetch(`${base}/api/observations/${id}`)).status, 404);
  } finally {
    srv.close();
  }
});
