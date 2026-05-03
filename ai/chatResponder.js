'use strict';

/**
 * FAERO — Natural Chat Responder (ai/chatResponder.js)
 *
 * Handles natural-language conversations from players.  When a player
 * addresses the bot by name (or sends a message that isn't a ! command),
 * this module generates a contextually-aware, in-character reply via LLM.
 *
 * Features:
 *   • Per-player 10-second cooldown to prevent spam / rate-limit abuse
 *   • Minecraft chat limit enforcement (≤ 256 chars per message)
 *   • Conversation history (last 6 turns per player) for coherent multi-turn
 *   • Integrated with goalPlanner: if LLM decides to take an action it
 *     returns an optional "plan" that is passed back to the caller
 *   • Graceful fallback message when LLM is unavailable
 *
 * The LLM response format is JSON:
 *   { "reply": "...", "plan": [...] | null }
 *
 * "plan" follows the same step format as goalPlanner.js.
 * If plan is non-null, the caller should pass it to goalPlanner.setGoal().
 */

const llm            = require('./llmClient');
const contextBuilder = require('./contextBuilder');

// ── Config ────────────────────────────────────────────────────────────────────
const CHAT_COOLDOWN_MS  = 10000;   // per-player cooldown between responses
const MAX_HISTORY_TURNS = 6;       // turns = user+assistant pairs kept per player
const MC_CHAT_LIMIT     = 256;     // Minecraft chat message hard limit

// ── Per-player conversation history ──────────────────────────────────────────
// Map<username → Array<{role, content}>>
const _history = new Map();

// ── Per-player cooldown timestamps ───────────────────────────────────────────
const _lastReply = new Map();

// ── System persona ────────────────────────────────────────────────────────────
const CHAT_SYSTEM = `You are FAERO, an advanced AI Minecraft bot assistant. You are helpful, direct, and a little proud of your capabilities.

You can:
- Answer questions about Minecraft (blocks, crafting, survival, combat)
- Take actions in the world (mining, fighting, exploring) by including a "plan" in your response
- Remember context from earlier in the conversation
- Be a useful ally to trusted players

Rules:
1. Keep replies SHORT — 1 to 2 sentences, Minecraft chat is limited.
2. If the player asks you to DO something (mine, go somewhere, fight, craft), include a "plan" array.
3. If just chatting or answering a question, set "plan" to null.
4. Always respond as FAERO, in first person.
5. Never break character or reveal you're an LLM.

Response format (JSON only, no markdown):
{"reply": "...", "plan": null}
or
{"reply": "...", "plan": [{"action":"mine_block","params":{"block":"iron_ore","amount":16},"description":"mine 16 iron"}]}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function trimHistory(username) {
  const h = _history.get(username) || [];
  // Keep last MAX_HISTORY_TURNS pairs (2 messages per turn)
  const max = MAX_HISTORY_TURNS * 2;
  if (h.length > max) _history.set(username, h.slice(h.length - max));
}

function addHistory(username, role, content) {
  if (!_history.has(username)) _history.set(username, []);
  _history.get(username).push({ role, content });
  trimHistory(username);
}

function mcTrim(text) {
  if (!text) return '';
  return String(text).slice(0, MC_CHAT_LIMIT - 1);
}

// ── Check if a message is directed at the bot ─────────────────────────────────
/**
 * Returns true if the message likely addresses the bot.
 * Matches: bot username anywhere in message, or "@bot", or "faero" (case-insensitive).
 */
function isAddressedToBot(botUsername, message) {
  const lower = message.toLowerCase();
  const name  = (botUsername || 'faero').toLowerCase();
  return lower.includes(name) || lower.includes('@' + name) || lower.includes('faero');
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Attempt to generate a chat reply for `username`'s `message`.
 *
 * @param {object}   ctx       — botManager.getContext()
 * @param {string}   username  — Minecraft player username
 * @param {string}   message   — raw chat message
 * @param {object}   [snapshot]— optional decisionEngine snapshot
 * @returns {Promise<{reply:string|null, plan:Array|null}>}
 *   reply — text to send in game chat (null = cooldown / LLM unavailable)
 *   plan  — step list for goalPlanner, or null
 */
async function respond(ctx, username, message, snapshot) {
  if (!llm.isAvailable()) {
    return { reply: null, plan: null };
  }

  // ── Cooldown guard ─────────────────────────────────────────────────────────
  const now  = Date.now();
  const last = _lastReply.get(username) || 0;
  if (now - last < CHAT_COOLDOWN_MS) {
    return { reply: null, plan: null };
  }
  _lastReply.set(username, now);

  // ── Build messages ─────────────────────────────────────────────────────────
  const stateStr  = contextBuilder.stringify(ctx, snapshot, null);
  const history   = _history.get(username) || [];

  const messages = [
    { role: 'system', content: CHAT_SYSTEM },
    { role: 'system', content: 'Current bot state: ' + stateStr },
    ...history,
    { role: 'user',   content: username + ': ' + message }
  ];

  // ── Call LLM ───────────────────────────────────────────────────────────────
  let raw;
  try {
    raw = await llm.complete(messages, { maxTokens: 200, timeoutMs: 10000 });
  } catch (err) {
    if (ctx.manager) ctx.manager.log('[chatAI] LLM error: ' + err.message);
    return { reply: null, plan: null };
  }

  // ── Parse response ────────────────────────────────────────────────────────
  const parsed = llm.extractJSON(raw);
  let reply = null;
  let plan  = null;

  if (parsed && typeof parsed.reply === 'string') {
    reply = mcTrim(parsed.reply);
    plan  = Array.isArray(parsed.plan) && parsed.plan.length ? parsed.plan : null;
  } else {
    // LLM didn't return JSON — use raw text as reply, truncated
    reply = mcTrim(raw.replace(/```[\s\S]*?```/g, '').replace(/\n+/g, ' ').trim());
  }

  // ── Store turn in history ──────────────────────────────────────────────────
  addHistory(username, 'user',      username + ': ' + message);
  addHistory(username, 'assistant', reply || '');

  if (ctx.manager) ctx.manager.log('[chatAI] ' + username + ' → ' + reply);

  return { reply, plan };
}

/**
 * Clear conversation history for a specific player (or all players).
 */
function clearHistory(username) {
  if (username) _history.delete(username);
  else _history.clear();
}

/**
 * Returns true if LLM chat is available AND the message should trigger a response.
 * Does NOT enforce cooldown — call respond() for that.
 */
function shouldRespond(botUsername, message) {
  return llm.isAvailable() && isAddressedToBot(botUsername, message);
}

module.exports = { respond, shouldRespond, clearHistory, isAddressedToBot };
