'use strict';

/**
 * FAERO — Neural Social Engine (modules/socialEngine.js)
 *
 * Module 4: Persistent per-player social memory, human-like chat rhythm,
 * and rapport classification (FRIENDLY / NEUTRAL / HOSTILE).
 *
 * Features
 *   • Persistent PlayerMemory — conversation history, interaction counts,
 *     rapport score stored in MongoDB (auto-falls back to in-memory)
 *   • humanSay(bot, message) — simulates human typing: variable delay based
 *     on message length + jitter, preventing instant robotic responses
 *   • recordInteraction(username, type) — accumulates signals that shift
 *     rapport: greetings, threats, attacks, gifts, farewells, etc.
 *   • getProfile(username) — returns full rapport snapshot for a player
 *   • Rapport score range: -100 (hostile) ↔ 0 (neutral) ↔ +100 (friendly)
 *     Classifications: HOSTILE < -20, NEUTRAL -20…+20, FRIENDLY > +20
 */

const mongo  = require('../lib/persistence/mongo');
const models = require('../lib/persistence/models');

// ── Typing rhythm constants ───────────────────────────────────────────────────
// Simulates a human typing speed of ~45–80 WPM with natural variation.
const CHARS_PER_MS_MIN  = 0.06;  // ~900 chars/min = slow typer
const CHARS_PER_MS_MAX  = 0.14;  // ~2100 chars/min = fast typer
const JITTER_MIN_MS     = 200;
const JITTER_MAX_MS     = 900;
const MIN_DELAY_MS      = 400;   // always at least 400ms — never instant
const MAX_DELAY_MS      = 5000;  // cap so it doesn't feel broken

// ── Rapport scoring weights ───────────────────────────────────────────────────
const RAPPORT_DELTA = Object.freeze({
  greeting:      +4,
  compliment:    +6,
  thank:         +5,
  farewell:      +2,
  question:      +1,
  gift:          +10,
  trade:         +7,
  cooperate:     +5,
  neutral_chat:  +1,
  insult:        -6,
  threat:        -10,
  profanity:     -4,
  hostile_cmd:   -8,
  attack:        -20,
  spam:          -3,
});

const RAPPORT_MIN  = -100;
const RAPPORT_MAX  = 100;
const MAX_HISTORY  = 12; // conversation turns kept per player (user+assistant pairs)

// ── In-memory profile cache ───────────────────────────────────────────────────
// Map<username → profile>
// profile: { rapportScore, interactionCount, lastSeen, history, dirty }
const _cache = new Map();

// ── Sentiment keyword lists ───────────────────────────────────────────────────
const GREETING_RE  = /\b(hi|hey|hello|sup|yo|howdy|greetings|hiya|what'?s up)\b/i;
const FAREWELL_RE  = /\b(bye|goodbye|cya|see ya|later|farewell|gtg|good ?night)\b/i;
const THANK_RE     = /\b(thanks?|thank you|ty|thx|cheers|appreciate)\b/i;
const COMPLIMENT_RE= /\b(good|great|awesome|nice|cool|amazing|love|best|incredible|wow|impressive)\b/i;
const INSULT_RE    = /\b(idiot|stupid|dumb|moron|useless|trash|bad|worst|suck|noob|loser)\b/i;
const THREAT_RE    = /\b(kill you|destroy|attack|hunt you|come for you|murder|die|will get you)\b/i;
const PROFANITY_RE = /\b(fuck|shit|ass|bitch|bastard|damn|crap|wtf)\b/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function _randBetween(a, b) {
  return a + Math.random() * (b - a);
}

function _typingDelay(message) {
  const len = String(message || '').length;
  const cpm = _randBetween(CHARS_PER_MS_MIN, CHARS_PER_MS_MAX);
  const base = len / cpm;
  const jitter = _randBetween(JITTER_MIN_MS, JITTER_MAX_MS);
  return _clamp(Math.round(base + jitter), MIN_DELAY_MS, MAX_DELAY_MS);
}

function _blankProfile(username) {
  return {
    username,
    rapportScore:     0,
    interactionCount: 0,
    lastSeen:         null,
    history:          [],  // [{role, content, at}]
    dirty:            false
  };
}

function _classification(score) {
  if (score >  20) return 'FRIENDLY';
  if (score < -20) return 'HOSTILE';
  return 'NEUTRAL';
}

// ── Cache management ──────────────────────────────────────────────────────────

function _getOrCreate(username) {
  if (!_cache.has(username)) {
    _cache.set(username, _blankProfile(username));
  }
  return _cache.get(username);
}

async function _loadFromDB(username) {
  if (!mongo.isReady()) return null;
  return await models.getPlayerMemory(username);
}

async function _persistProfile(profile) {
  if (!mongo.isReady() || !profile.dirty) return;
  try {
    await models.upsertPlayerMemory({
      username:         profile.username,
      rapportScore:     profile.rapportScore,
      interactionCount: profile.interactionCount,
      lastSeen:         profile.lastSeen,
      history:          profile.history.slice(-MAX_HISTORY * 2)
    });
    profile.dirty = false;
  } catch (_) {}
}

// ── Public: load a profile (DB-backed with in-memory cache) ──────────────────

/**
 * Load (or warm from DB) a player's social profile.
 * Always returns a profile object — never throws.
 */
async function loadProfile(username) {
  if (_cache.has(username)) return _cache.get(username);
  const dbDoc = await _loadFromDB(username);
  if (dbDoc) {
    const profile = {
      username:         dbDoc.username,
      rapportScore:     dbDoc.rapportScore    || 0,
      interactionCount: dbDoc.interactionCount|| 0,
      lastSeen:         dbDoc.lastSeen        || null,
      history:          Array.isArray(dbDoc.history) ? dbDoc.history : [],
      dirty:            false
    };
    _cache.set(username, profile);
    return profile;
  }
  return _getOrCreate(username);
}

/**
 * Synchronous profile lookup — returns cached profile or a blank one.
 * Call loadProfile() first if you need DB-backed data.
 */
function getProfile(username) {
  const profile = _cache.get(username) || _blankProfile(username);
  return {
    username:         profile.username,
    rapportScore:     profile.rapportScore,
    classification:   _classification(profile.rapportScore),
    interactionCount: profile.interactionCount,
    lastSeen:         profile.lastSeen,
    historyLength:    profile.history.length
  };
}

/**
 * Return all cached profiles as an array (for dashboard/API).
 */
function getAllProfiles() {
  return Array.from(_cache.values()).map(p => ({
    username:         p.username,
    rapportScore:     p.rapportScore,
    classification:   _classification(p.rapportScore),
    interactionCount: p.interactionCount,
    lastSeen:         p.lastSeen
  }));
}

// ── Public: record an interaction and update rapport ─────────────────────────

/**
 * Infer interaction type from a raw chat message string.
 * Returns the interaction type string to pass to recordInteraction().
 */
function inferInteractionType(message) {
  const m = String(message || '');
  if (THREAT_RE.test(m))    return 'threat';
  if (INSULT_RE.test(m))    return 'insult';
  if (PROFANITY_RE.test(m)) return 'profanity';
  if (THANK_RE.test(m))     return 'thank';
  if (COMPLIMENT_RE.test(m))return 'compliment';
  if (GREETING_RE.test(m))  return 'greeting';
  if (FAREWELL_RE.test(m))  return 'farewell';
  if (m.endsWith('?'))      return 'question';
  return 'neutral_chat';
}

/**
 * Record an interaction for a player and adjust their rapport score.
 *
 * @param {string} username
 * @param {string} type — one of the RAPPORT_DELTA keys
 * @param {object} [opts]
 * @param {string} [opts.message]  — raw message text (stored in history)
 * @param {string} [opts.role]     — 'user' | 'assistant' (for history)
 */
async function recordInteraction(username, type, opts) {
  const profile = await loadProfile(username);
  const delta   = RAPPORT_DELTA[type] || 0;

  profile.rapportScore     = _clamp(profile.rapportScore + delta, RAPPORT_MIN, RAPPORT_MAX);
  profile.interactionCount += 1;
  profile.lastSeen          = new Date().toISOString();
  profile.dirty             = true;

  if (opts && opts.message) {
    profile.history.push({
      role:    opts.role || 'user',
      content: opts.message,
      at:      new Date().toISOString()
    });
    if (profile.history.length > MAX_HISTORY * 2) {
      profile.history = profile.history.slice(-MAX_HISTORY * 2);
    }
  }

  // Persist to DB asynchronously — never block the chat pipeline
  _persistProfile(profile).catch(() => {});

  return {
    username,
    rapportScore:   profile.rapportScore,
    classification: _classification(profile.rapportScore),
    delta
  };
}

/**
 * Add an assistant reply to a player's conversation history.
 */
async function recordReply(username, replyText) {
  const profile = await loadProfile(username);
  profile.history.push({
    role:    'assistant',
    content: replyText,
    at:      new Date().toISOString()
  });
  if (profile.history.length > MAX_HISTORY * 2) {
    profile.history = profile.history.slice(-MAX_HISTORY * 2);
  }
  profile.dirty = true;
  _persistProfile(profile).catch(() => {});
}

/**
 * Get the conversation history for a player (for LLM context injection).
 * Returns an array of {role, content} objects — compatible with OpenAI message format.
 */
async function getHistory(username) {
  const profile = await loadProfile(username);
  return profile.history.map(h => ({ role: h.role, content: h.content }));
}

/**
 * Wipe history and reset rapport for a player.
 */
async function clearProfile(username) {
  _cache.delete(username);
  if (mongo.isReady()) {
    await models.deletePlayerMemory(username).catch(() => {});
  }
}

// ── Public: humanSay — human-like typing rhythm ───────────────────────────────

/**
 * Send a chat message with a human-like typing delay.
 * The delay scales with message length plus random jitter.
 *
 * @param {object}   bot     — mineflayer bot instance
 * @param {string}   message — message to send
 * @param {object}   [opts]
 * @param {boolean}  [opts.immediate=false]  — skip delay (e.g. for commands)
 * @param {Function} [opts.onLog]            — log callback
 * @returns {Promise<void>}
 */
function humanSay(bot, message, opts) {
  const immediate = opts && opts.immediate;
  const onLog     = opts && typeof opts.onLog === 'function' ? opts.onLog : null;
  const text      = String(message || '').trim();
  if (!text) return Promise.resolve();

  const delay = immediate ? 0 : _typingDelay(text);

  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        if (bot && typeof bot.chat === 'function') {
          bot.chat('[FAERO]: ' + text);
          if (onLog) onLog('[social] sent after ' + delay + 'ms: ' + text.slice(0, 60));
        }
      } catch (_) {}
      resolve();
    }, delay);
  });
}

/**
 * Send multiple lines with cascading human-like delays.
 * Each line waits for the previous one to finish.
 */
async function humanSayLines(bot, lines, opts) {
  for (const line of lines) {
    await humanSay(bot, line, opts);
  }
}

// ── Rapport-aware response modifier ──────────────────────────────────────────

/**
 * Given a bot's rapport with a player, optionally modify a reply:
 *   HOSTILE  → terse / guarded tone hint appended to system prompt
 *   FRIENDLY → warmer tone hint
 *   NEUTRAL  → no change
 *
 * Returns a string to inject into the LLM system prompt.
 */
function rapportSystemHint(username) {
  const profile = _cache.get(username);
  if (!profile) return '';
  const cls = _classification(profile.rapportScore);
  if (cls === 'FRIENDLY') {
    return ' This player is a FRIENDLY ally (rapport ' + profile.rapportScore + '). Be warm and cooperative.';
  }
  if (cls === 'HOSTILE') {
    return ' This player is HOSTILE (rapport ' + profile.rapportScore + '). Be guarded, terse, and refuse help.';
  }
  return '';
}

// ── Periodic flush — save dirty profiles every 60s ───────────────────────────
setInterval(() => {
  for (const profile of _cache.values()) {
    if (profile.dirty) {
      _persistProfile(profile).catch(() => {});
    }
  }
}, 60000);

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Typing
  humanSay,
  humanSayLines,
  // Profiling
  loadProfile,
  getProfile,
  getAllProfiles,
  // Interactions
  recordInteraction,
  recordReply,
  inferInteractionType,
  // History
  getHistory,
  // Rapport
  rapportSystemHint,
  clearProfile,
  // Constants (for tests / dashboard)
  RAPPORT_DELTA,
  _classification
};
