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
  complete: async p => (p.includes('<summary>') ? SUM_XML : OBS_XML),
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
  assert.deepEqual(stats, { observations: 1, summaries: 1 });

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

  const notes = fs.readdirSync(path.join(vault, 'demo'));
  assert.ok(notes.includes('demo.md'), 'project index note');
  const note = fs.readFileSync(path.join(vault, 'demo', notes.find(n => n !== 'demo.md')), 'utf8');
  assert.match(note, /tags: \[open-mem\]/);
  assert.match(note, /\[\[demo\]\]/);
});

test('vault ingest: incremental, deduplicated, exclusions, deletions, context', async () => {
  const { ingestVault, searchNotes } = await import('../src/vault.mjs');
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
  assert.deepEqual(byId[2].result.tools.map(t => t.name), ['search', 'timeline', 'get_observations', 'save_memory', 'vault_search']);
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
