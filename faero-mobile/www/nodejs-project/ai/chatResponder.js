'use strict';

/**
 * FAERO — Natural Chat Responder (ai/chatResponder.js)
 *
 * Handles natural-language conversations from players. When a player
 * addresses the bot by name (or sends any non-command message), this module
 * generates a contextually-aware, in-character reply via LLM.
 *
 * Module 4 Neural Social Engine integration:
 *   • Persistent conversation history loaded from socialEngine (MongoDB-backed)
 *   • humanSay() used for all replies — adds human typing rhythm/delay
 *   • Rapport hint injected into system prompt (FRIENDLY / HOSTILE tone shift)
 *   • All interactions recorded to rapport scoring system
 */

const llm            = require('./llmClient');
const contextBuilder = require('./contextBuilder');
const social         = require('../modules/socialEngine');

// ── Config ────────────────────────────────────────────────────────────────────
const CHAT_COOLDOWN_MS = 10000;
const MC_CHAT_LIMIT    = 256;

// ── Per-player cooldown timestamps ───────────────────────────────────────────
const _lastReply = new Map();

// ── Base system persona ───────────────────────────────────────────────────────
const CHAT_SYSTEM_BASE = `You are FAERO, an advanced AI Minecraft bot assistant. You are helpful, direct, and a little proud of your capabilities.

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
6. Adjust your tone based on your rapport with this player (hostile players get guarded, terse replies).

Response format (JSON only, no markdown):
{"reply": "...", "plan": null}
or
{"reply": "...", "plan": [{"action":"mine_block","params":{"block":"iron_ore","amount":16},"description":"mine 16 iron"}]}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function mcTrim(text) {
  if (!text) return '';
  return String(text).slice(0, MC_CHAT_LIMIT - 1);
}

function isAddressedToBot(botUsername, message) {
  const lower = message.toLowerCase();
  const name  = (botUsername || 'faero').toLowerCase();
  return lower.includes(name) || lower.includes('@' + name) || lower.includes('faero');
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Attempt to generate a chat reply for `username`'s `message`.
 * Uses persistent social memory for conversation history.
 * Sends reply via humanSay() for natural typing rhythm.
 *
 * @param {object}   ctx       — botManager.getContext()
 * @param {string}   username  — Minecraft player username
 * @param {string}   message   — raw chat message
 * @param {object}   [snapshot]— optional decisionEngine snapshot
 * @returns {Promise<{reply:string|null, plan:Array|null}>}
 */
async function respond(ctx, username, message, snapshot) {
  if (!llm.isAvailable()) return { reply: null, plan: null };

  // ── Cooldown guard ─────────────────────────────────────────────────────────
  const now  = Date.now();
  const last = _lastReply.get(username) || 0;
  if (now - last < CHAT_COOLDOWN_MS) return { reply: null, plan: null };
  _lastReply.set(username, now);

  // ── Record interaction & load social context ───────────────────────────────
  const interactionType = social.inferInteractionType(message);
  await social.recordInteraction(username, interactionType, {
    message,
    role: 'user'
  });

  const rapportHint = social.rapportSystemHint(username);
  const systemPrompt = CHAT_SYSTEM_BASE + rapportHint;

  // ── Load persistent conversation history ───────────────────────────────────
  const history  = await social.getHistory(username);
  const stateStr = contextBuilder.stringify(ctx, snapshot, null);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: 'Current bot state: ' + stateStr },
    ...history.slice(-12),  // last 6 turns
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

  // ── Parse response ─────────────────────────────────────────────────────────
  const parsed = llm.extractJSON(raw);
  let reply = null;
  let plan  = null;

  if (parsed && typeof parsed.reply === 'string') {
    reply = mcTrim(parsed.reply);
    plan  = Array.isArray(parsed.plan) && parsed.plan.length ? parsed.plan : null;
  } else {
    reply = mcTrim(raw.replace(/```[\s\S]*?```/g, '').replace(/\n+/g, ' ').trim());
  }

  // ── Store assistant reply in persistent social memory ──────────────────────
  if (reply) {
    await social.recordReply(username, reply);
  }

  if (ctx.manager) ctx.manager.log('[chatAI] ' + username + ' (' + social._classification(social.getProfile(username).rapportScore) + ') → ' + reply);

  // ── Send with human-like typing delay ─────────────────────────────────────
  if (reply && ctx.bot) {
    social.humanSay(ctx.bot, reply, {
      onLog: ctx.manager ? (msg) => ctx.manager.log(msg) : null
    }).catch(() => {});
  }

  return { reply, plan };
}

/**
 * Clear conversation history for a specific player (or all players).
 */
function clearHistory(username) {
  if (username) social.clearProfile(username).catch(() => {});
  else {
    // Clear is handled by socialEngine cache; full wipe requires DB call per user
  }
}

/**
 * Returns true if LLM chat is available AND the message should trigger a response.
 */
function shouldRespond(botUsername, message) {
  return llm.isAvailable() && isAddressedToBot(botUsername, message);
}

module.exports = { respond, shouldRespond, clearHistory, isAddressedToBot };
