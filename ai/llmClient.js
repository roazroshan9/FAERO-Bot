'use strict';

/**
 * FAERO — LLM Client (ai/llmClient.js)
 *
 * Unified API client for Groq (primary) and DeepSeek (fallback).
 * Uses Node 20 native fetch — no extra dependencies.
 *
 * Environment variables:
 *   GROQ_API_KEY      — Groq cloud API key (get free at console.groq.com)
 *   GROQ_MODEL        — default: llama-3.3-70b-versatile
 *   DEEPSEEK_API_KEY  — DeepSeek API key (fallback)
 *   DEEPSEEK_MODEL    — default: deepseek-chat
 *   LLM_TIMEOUT_MS    — per-request timeout, default 12000
 *   LLM_MAX_TOKENS    — max response tokens, default 512
 */

const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

const DEFAULT_GROQ_MODEL     = 'llama-3.3-70b-versatile';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS     = 12000;
const DEFAULT_MAX_TOKENS     = 512;

// ── Rate limiter — simple token bucket (per provider) ─────────────────────────
const _buckets = {};

function getBucket(provider) {
  if (!_buckets[provider]) {
    _buckets[provider] = { tokens: 25, lastRefill: Date.now() };
  }
  const b = _buckets[provider];
  const elapsed = Date.now() - b.lastRefill;
  if (elapsed >= 60000) {
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

// ── Core HTTP call ─────────────────────────────────────────────────────────────
async function callAPI(url, apiKey, model, messages, maxTokens, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
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
      throw new Error('LLM API ' + res.status + ': ' + body.slice(0, 120));
    }

    const data = await res.json();
    const content = data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;

    if (!content) throw new Error('LLM returned empty content');
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}

// ── Public: chat completion ────────────────────────────────────────────────────
/**
 * Send a messages array to the configured LLM provider.
 * Tries Groq first, falls back to DeepSeek if Groq key is absent or fails.
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

  // ── Groq (primary) ─────────────────────────────────────────────────────────
  if (groqKey) {
    if (!consumeToken('groq')) throw new Error('LLM rate limit reached — try again in a moment.');
    const model = process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
    try {
      return await callAPI(GROQ_URL, groqKey, model, messages, maxTokens, timeoutMs);
    } catch (err) {
      if (!deepseekKey) throw err;
      // Fall through to DeepSeek
    }
  }

  // ── DeepSeek (fallback) ────────────────────────────────────────────────────
  if (!consumeToken('deepseek')) throw new Error('LLM rate limit reached — try again in a moment.');
  const model = process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL;
  return await callAPI(DEEPSEEK_URL, deepseekKey, model, messages, maxTokens, timeoutMs);
}

/**
 * Extract a JSON object/array embedded in raw LLM text.
 * Many models wrap JSON in markdown code fences — this strips them.
 */
function extractJSON(text) {
  if (!text) return null;
  let s = text.trim();
  // Strip ```json ... ``` or ``` ... ```
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  // Find first { or [
  const start = s.search(/[\[{]/);
  if (start === -1) return null;
  s = s.slice(start);
  // Find matching close
  const open  = s[0];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let end   = -1;
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

module.exports = { complete, extractJSON, isAvailable };
