'use strict';

/**
 * FAERO — Self-Learning Module (ai/selfLearning.js)
 *
 * Two independent stores, both backed by local JSON files so they survive
 * restarts even without a MongoDB connection:
 *
 *   DeathLog     — records every bot death (cause, position, timestamp)
 *   FailureLog   — records goal-step failures so the AI avoids repeating them
 *
 * Public API:
 *   logDeath({ botName, cause, x, y, z })
 *   getRecentDeaths(limit)
 *   logGoalFailure({ goalText, stepAction, errorMsg })
 *   getPatterns()
 *   checkPattern(goalText)          → matched failure entries
 *   formatPatternWarning(patterns)  → human-readable string for LLM prompt
 */

const fs   = require('fs');
const path = require('path');

const DEATHS_FILE   = path.join(process.cwd(), '.faero-deaths.json');
const FAILURES_FILE = path.join(process.cwd(), '.faero-failures.json');

const MAX_DEATHS   = 100;
const MAX_FAILURES = 200;

// ── File I/O helpers ──────────────────────────────────────────────────────────

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return fallback;
}

function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (_) {}
}

// ── Death Log ─────────────────────────────────────────────────────────────────

/**
 * Persist a death event to .faero-deaths.json.
 * @param {{ botName?:string, cause:string, x:number, y:number, z:number }} opts
 */
function logDeath({ botName, cause, x, y, z }) {
  const list = readJSON(DEATHS_FILE, []);
  list.push({
    botName: botName || 'faero',
    cause:   String(cause  || 'unknown').slice(0, 80),
    x:       Math.round(Number(x) || 0),
    y:       Math.round(Number(y) || 0),
    z:       Math.round(Number(z) || 0),
    at:      Date.now()
  });
  if (list.length > MAX_DEATHS) list.splice(0, list.length - MAX_DEATHS);
  writeJSON(DEATHS_FILE, list);
}

/**
 * Return the most recent N death records.
 * @param {number} [limit=10]
 * @returns {Array}
 */
function getRecentDeaths(limit) {
  return readJSON(DEATHS_FILE, []).slice(-(limit || 10));
}

// ── Failure Pattern Store ─────────────────────────────────────────────────────

function normalizeGoal(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Record a goal-step failure.  Merges into an existing entry if the same
 * (goalKey, stepAction) pair has been seen before — increments count.
 *
 * @param {{ goalText:string, stepAction:string, errorMsg:string }} opts
 */
function logGoalFailure({ goalText, stepAction, errorMsg }) {
  const list = readJSON(FAILURES_FILE, []);
  const key  = normalizeGoal(goalText);
  const step = String(stepAction || 'unknown');

  const existing = list.find(f => f.key === key && f.stepAction === step);
  if (existing) {
    existing.count++;
    existing.lastError = String(errorMsg || existing.lastError || '').slice(0, 120);
    existing.lastAt    = Date.now();
  } else {
    list.push({
      key,
      goalText:   String(goalText  || '').slice(0, 120),
      stepAction: step,
      lastError:  String(errorMsg  || '').slice(0, 120),
      count:      1,
      firstAt:    Date.now(),
      lastAt:     Date.now()
    });
  }

  if (list.length > MAX_FAILURES) list.splice(0, list.length - MAX_FAILURES);
  writeJSON(FAILURES_FILE, list);
}

/**
 * Return all stored failure patterns.
 * @returns {Array}
 */
function getPatterns() {
  return readJSON(FAILURES_FILE, []);
}

/**
 * Return failure entries that match the given goal text.
 * Matches if keys are identical or one contains the other.
 * @param {string} goalText
 * @returns {Array}
 */
function checkPattern(goalText) {
  const key  = normalizeGoal(goalText);
  const list = readJSON(FAILURES_FILE, []);
  return list.filter(f =>
    f.key === key ||
    (key.length > 4 && key.includes(f.key)) ||
    (f.key.length > 4 && f.key.includes(key))
  );
}

/**
 * Format matched patterns into a compact string for injection into an LLM
 * system prompt.  Returns null when there are no relevant patterns.
 * @param {Array} patterns
 * @returns {string|null}
 */
function formatPatternWarning(patterns) {
  if (!Array.isArray(patterns) || !patterns.length) return null;
  return patterns
    .slice(0, 4)
    .map(p =>
      'Step "' + p.stepAction + '" failed ' + p.count +
      ' time(s) — last error: ' + (p.lastError || 'unknown')
    )
    .join('; ');
}

module.exports = {
  logDeath,
  getRecentDeaths,
  logGoalFailure,
  getPatterns,
  checkPattern,
  formatPatternWarning
};
