'use strict';

/**
 * FAERO — LLM Client (ai/llmClient.js)
 *
 * Primary:  Groq  via the official groq-sdk   (GROQ_API_KEY)
 * Fallback: DeepSeek via native fetch          (DEEPSEEK_API_KEY)
 *
 * Environment variables:
 *   GROQ_API_KEY      — Groq cloud API key (console.groq.com — free tier available)
 *   GROQ_MODEL        — default: llama-3.3-70b-versatile
 *   DEEPSEEK_API_KEY  — DeepSeek API key (fallback)
 *   DEEPSEEK_MODEL    — default: deepseek-chat
 *   LLM_TIMEOUT_MS    — per-request timeout ms, default 12000
 *   LLM_MAX_TOKENS    — max response tokens, default 512
 */

const DEFAULT_GROQ_MODEL     = 'llama-3.3-70b-versatile';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS     = 12000;
const DEFAULT_MAX_TOKENS     = 512;
const DEEPSEEK_URL           = 'https://api.deepseek.com/chat/completions';

// ── Rate limiter — simple token bucket (per provider) ─────────────────────────
const _buckets = {};

function getBucket(provider) {
  if (!_buckets[provider]) {
    _buckets[provider] = { tokens: 25, lastRefill: Date.now() };
  }
  const b = _buckets[provider];
  if (Date.now() - b.lastRefill >= 60000) {
    b.tokens = 25;
    b.lastRefill = Date.now();
  }
  return b;
}

function consumeToken(provider) {
  const b = getBucket(provider);
  if (b.tokens <= 0) return false;
  b.tokens--;
  return true;
}

// ── Groq SDK call ──────────────────────────────────────────────────────────────
async function callGroq(apiKey, model, messages, maxTokens, timeoutMs) {
  const Groq = require('groq-sdk');
  const client = new Groq({ apiKey, timeout: timeoutMs });

  const completion = await client.chat.completions.create({
    model,
    messages,
    max_tokens:  maxTokens,
    temperature: 0.4
  });

  const content = completion &&
    completion.choices &&
    completion.choices[0] &&
    completion.choices[0].message &&
    completion.choices[0].message.content;

  if (!content) throw new Error('Groq returned empty content');
  return content.trim();
}

// ── DeepSeek fallback — native fetch ──────────────────────────────────────────
async function callDeepSeek(apiKey, model, messages, maxTokens, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(DEEPSEEK_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens:  maxTokens,
        temperature: 0.4
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('DeepSeek API ' + res.status + ': ' + body.slice(0, 120));
    }

    const data    = await res.json();
    const content = data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;

    if (!content) throw new Error('DeepSeek returned empty content');
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}

// ── Public: chat completion ────────────────────────────────────────────────────
/**
 * Send a messages array to the configured LLM provider.
 * Tries Groq (SDK) first, falls back to DeepSeek (native fetch) if Groq is
 * absent or fails.
 *
 * @param {Array<{role:'system'|'user'|'assistant', content:string}>} messages
 * @param {object} [opts]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string>} raw text response
 */
async function complete(messages, opts) {
  const maxTokens = (opts && opts.maxTokens) || Number(process.env.LLM_MAX_TOKENS) || DEFAULT_MAX_TOKENS;
  const timeoutMs = (opts && opts.timeoutMs) || Number(process.env.LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const groqKey     = process.env.GROQ_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;

  if (!groqKey && !deepseekKey) {
    throw new Error('No LLM API key configured. Set GROQ_API_KEY or DEEPSEEK_API_KEY in secrets.');
  }

  // ── Groq SDK (primary) ─────────────────────────────────────────────────────
  if (groqKey) {
    if (!consumeToken('groq')) throw new Error('LLM rate limit reached — try again in a moment.');
    const model = process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
    try {
      return await callGroq(groqKey, model, messages, maxTokens, timeoutMs);
    } catch (err) {
      if (!deepseekKey) throw err;
      // Fall through to DeepSeek fallback
    }
  }

  // ── DeepSeek fallback ──────────────────────────────────────────────────────
  if (!consumeToken('deepseek')) throw new Error('LLM rate limit reached — try again in a moment.');
  const model = process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL;
  return await callDeepSeek(deepseekKey, model, messages, maxTokens, timeoutMs);
}

/**
 * Extract a JSON object/array embedded in raw LLM text.
 * Strips markdown code fences that models often wrap JSON in.
 */
function extractJSON(text) {
  if (!text) return null;
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const start = s.search(/[\[{]/);
  if (start === -1) return null;
  s = s.slice(start);
  const open  = s[0];
  const close = open === '[' ? ']' : '}';
  let depth = 0, end = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === open)  depth++;
    if (s[i] === close) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(s.slice(0, end + 1)); } catch (_) { return null; }
}

function isAvailable() {
  return Boolean(process.env.GROQ_API_KEY || process.env.DEEPSEEK_API_KEY);
}

function getProviderInfo() {
  const hasGroq     = Boolean(process.env.GROQ_API_KEY);
  const hasDeepSeek = Boolean(process.env.DEEPSEEK_API_KEY);
  if (hasGroq)     return { provider: 'groq',     model: process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL,         available: true  };
  if (hasDeepSeek) return { provider: 'deepseek', model: process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL, available: true  };
  return { provider: null, model: null, available: false };
}

module.exports = { complete, extractJSON, isAvailable, getProviderInfo };
