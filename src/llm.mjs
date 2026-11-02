// Observer model providers: local Ollama, your Claude plan via `claude -p`, or any OpenAI-compatible API.
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TIMEOUT = 180_000;

async function post(url, body, headers = {}, timeout = TIMEOUT) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

function claudeCli(prompt, model) {
  return new Promise((resolve, reject) => {
    // OPEN_MEM_DISABLE stops our own hooks from recording the observer's session (no feedback loop).
    // Skipping user settings, MCP servers and skills cuts startup from ~18s to ~6s and keeps other
    // plugins' hooks out of the observer session; running from tmpdir avoids project CLAUDE.md files.
    const p = spawn('claude', ['-p', '--model', model, '--output-format', 'text', '--strict-mcp-config',
      '--setting-sources', 'local', '--disable-slash-commands', '--no-session-persistence'], {
      cwd: os.tmpdir(),
      env: { ...process.env, OPEN_MEM_DISABLE: '1' },
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('claude -p timed out')); }, TIMEOUT);
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`claude -p exit ${code}: ${err.slice(0, 300)}`)); });
    p.stdin.end(prompt);
  });
}

export async function complete(prompt, s) {
  if (s.provider === 'ollama') {
    const j = await post(`${s.ollamaUrl}/api/chat`, {
      model: s.model, stream: false, options: { temperature: 0.2 },
      messages: [{ role: 'user', content: prompt }],
    });
    return j.message?.content ?? '';
  }
  if (s.provider === 'openai') {
    const key = process.env.OPEN_MEM_API_KEY || s.openaiApiKey;
    const j = await post(`${s.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      model: s.model, temperature: 0.2, messages: [{ role: 'user', content: prompt }],
    }, key ? { authorization: `Bearer ${key}` } : {});
    return j.choices?.[0]?.message?.content ?? '';
  }
  if (s.provider === 'claude') return claudeCli(prompt, s.claudeModel);
  throw new Error(`unknown provider "${s.provider}" (use ollama | claude | openai)`);
}

// Fast reachability check, no generation: is the provider up and are the models installed?
// A few milliseconds: one local HTTP call to Ollama (and a PATH lookup for the claude CLI).
export async function ping(s) {
  const t = performance.now();
  const out = { provider: s.provider, ok: false, missing: [] };
  try {
    if (s.provider === 'ollama' || s.embedModel) {
      const r = await fetch(`${s.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const names = (await r.json()).models?.map(m => m.name) ?? [];
      const has = m => names.some(n => n === m || n === `${m}:latest`);
      if (s.provider === 'ollama' && !has(s.model)) out.missing.push(s.model);
      if (s.embedModel && !has(s.embedModel)) out.embedMissing = s.embedModel;
      out.embeddings = !!s.embedModel && !out.embedMissing;
    }
  } catch {
    if (s.provider === 'ollama') { out.error = `Ollama is not running at ${s.ollamaUrl}`; out.ms = performance.now() - t; return out; }
    out.embeddings = false;
  }
  try {
    if (s.provider === 'openai') {
      const key = process.env.OPEN_MEM_API_KEY || s.openaiApiKey;
      const r = await fetch(`${s.openaiBaseUrl.replace(/\/$/, '')}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`${s.openaiBaseUrl} -> HTTP ${r.status}`);
    }
    if (s.provider === 'claude') {
      // Look the CLI up on PATH instead of spawning it: same answer, microseconds instead of ~70ms.
      const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
      const found = (process.env.PATH || '').split(path.delimiter).some(d => d && exts.some(e => fs.existsSync(path.join(d, `claude${e}`))));
      if (!found) throw new Error('claude CLI not found on PATH');
    }
    out.ok = !out.missing.length;
    if (out.missing.length) out.error = `Model not installed. Run: ollama pull ${out.missing[0]}`;
  } catch (e) { out.error = e.message; }
  out.ms = performance.now() - t;
  return out;
}

// Embeddings come from Ollama whatever the observer provider is. Returns null when unavailable,
// so search silently degrades to keyword-only.
export async function embed(texts, s, timeout = 120_000) {
  if (!s.embedModel || !texts.length) return null;
  try {
    const j = await post(`${s.ollamaUrl}/api/embed`, { model: s.embedModel, input: texts }, {}, timeout);
    return j.embeddings ?? null;
  } catch {
    return null;
  }
}

// One search query's vector, with a short timeout so a slow Ollama never stalls search.
export const embedQuery = async (query, s) => (query ? (await embed([query], s, 5000))?.[0] ?? null : null);
