'use strict';
/*
 * A stronger ad-script writer than the free Cloudflare model, through any OpenAI-compatible chat API. Configure with env vars on the server:
 *
 *   SCRIPT_PROVIDER = github | cerebras | mistral | groq | openrouter | custom     (picks the URL and a good default model)
 *   SCRIPT_API_KEY  = the provider's key   (for `github`: a GitHub personal access token that may use GitHub Models)
 *   SCRIPT_MODEL    = optional, overrides the default model
 *   SCRIPT_API_URL  = only for `custom`: the full .../chat/completions URL
 *
 * If nothing is configured, or the call fails for any reason, the caller falls back to Cloudflare Workers AI - a film is never lost to this.
 */
const fetch = require('node-fetch');

const PRESETS = {
  github: { url: 'https://models.github.ai/inference/chat/completions', model: 'openai/gpt-4.1' },
  cerebras: { url: 'https://api.cerebras.ai/v1/chat/completions', model: 'qwen-3-235b-a22b-instruct-2507' },
  mistral: { url: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-large-latest' },
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', model: 'openai/gpt-4.1-mini' },
};

const conf = () => {
  const key = process.env.SCRIPT_API_KEY;
  if (!key) return null;
  const p = PRESETS[String(process.env.SCRIPT_PROVIDER || '').toLowerCase()] || {};
  const url = process.env.SCRIPT_API_URL || p.url, model = process.env.SCRIPT_MODEL || p.model;
  return url && model ? { key, url, model, provider: String(process.env.SCRIPT_PROVIDER || 'custom').toLowerCase() } : null;
};
const enabled = () => !!conf();
const label = () => { const c = conf(); return c ? `${c.provider}/${c.model}` : 'cloudflare'; };

/** One JSON-mode chat completion; returns the message text. Throws on any failure (the caller falls back). */
async function chatJson(system, prompt, { maxTokens = 2600, temperature = 0.8, timeoutMs = 90000 } = {}) {
  const c = conf(); if (!c) throw new Error('no script API configured');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { Authorization: 'Bearer ' + c.key, 'Content-Type': 'application/json' };
    if (c.provider === 'github') { headers.Accept = 'application/vnd.github+json'; headers['X-GitHub-Api-Version'] = '2022-11-28'; }
    const body = { model: c.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: maxTokens, temperature, response_format: { type: 'json_object' } };
    const r = await fetch(c.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    const t = await r.text();
    if (!r.ok) throw new Error(`${c.provider} ${r.status}: ${t.slice(0, 200)}`);
    const j = JSON.parse(t), choice = j.choices && j.choices[0];
    if (!choice || !choice.message || !choice.message.content) throw new Error(`${c.provider} returned no text`);
    if (choice.finish_reason === 'length') throw new Error(`${c.provider} answer was truncated (max_tokens)`);
    return choice.message.content;
  } finally { clearTimeout(timer); }
}

module.exports = { enabled, label, chatJson, PRESETS };
