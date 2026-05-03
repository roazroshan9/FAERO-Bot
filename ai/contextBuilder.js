'use strict';

/**
 * FAERO — Context Builder (ai/contextBuilder.js)
 *
 * Converts live bot state into a compact, token-efficient JSON summary
 * that is injected into every LLM prompt.  Designed to stay under ~400
 * tokens so there is plenty of budget left for the system prompt and reply.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function round1(n) { return Math.round(Number(n) * 10) / 10; }
function roundPos(pos) {
  if (!pos) return null;
  return { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
}

// Top-N inventory items by count — keeps the prompt small
function topInventory(inventorySummary, limit) {
  limit = limit || 12;
  return Object.entries(inventorySummary || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .reduce((o, [k, v]) => { o[k] = v; return o; }, {});
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build a compact context object from the bot manager and an optional
 * decisionEngine snapshot.
 *
 * @param {object} ctx          — botManager.getContext()
 * @param {object} [snapshot]   — decisionEngine.think(bot) result (optional)
 * @param {string} [currentGoal]— active LLM goal string
 * @returns {object}            — plain JS object suitable for JSON.stringify
 */
function build(ctx, snapshot, currentGoal) {
  const bot = ctx && ctx.bot;
  const mgr = ctx && ctx.manager;

  // ── Bot vitals ────────────────────────────────────────────────────────────
  const health  = bot ? round1(bot.health)  : null;
  const hunger  = bot ? round1(bot.food)    : null;
  const pos     = bot && bot.entity ? roundPos(bot.entity.position) : null;
  const state   = mgr  ? mgr.stateManager.getState().state          : 'offline';

  // ── Inventory (compact) ───────────────────────────────────────────────────
  const inv = bot ? topInventory(
    snapshot ? snapshot.inventory : (bot.inventory
      ? bot.inventory.items().reduce((o, i) => { o[i.name] = (o[i.name] || 0) + i.count; return o; }, {})
      : {}
    )
  ) : {};

  // ── Nearby entities ───────────────────────────────────────────────────────
  const mobs    = (snapshot && snapshot.nearbyMobs)    ? snapshot.nearbyMobs.slice(0, 6)    : [];
  const players = (snapshot && snapshot.nearbyPlayers) ? snapshot.nearbyPlayers.slice(0, 4) : [];

  // ── Memory ────────────────────────────────────────────────────────────────
  const mem = ctx && ctx.memory;
  const trusted = mem ? (mem.data && mem.data.trustedPlayers || []).slice(0, 8) : [];
  const enemies = mem ? (mem.data && mem.data.enemies         || []).slice(0, 4) : [];
  const lastAction = mem && mem.data && mem.data.lastAction
    ? mem.data.lastAction.action
    : null;

  // ── Scanner map (if available on manager) ────────────────────────────────
  let nearbyBlocks = [];
  if (mgr && mgr._scanner && typeof mgr._scanner.getAll === 'function') {
    nearbyBlocks = mgr._scanner.getAll().slice(0, 8).map(b => b.name);
  }

  return {
    bot: {
      username: bot ? bot.username : 'unknown',
      health,
      hunger,
      position: pos,
      state
    },
    inventory: inv,
    nearby: {
      mobs:    mobs.map(m => ({ name: m.name, dist: m.distance != null ? Math.round(m.distance) : null })),
      players: players.map(p => ({ name: p.username, dist: p.distance != null ? Math.round(p.distance) : null })),
      blocks:  nearbyBlocks
    },
    memory: { trusted, enemies, lastAction },
    currentGoal: currentGoal || null
  };
}

/**
 * Stringify the context object for insertion into a prompt.
 * Returns a single-line JSON string (no pretty-print to save tokens).
 */
function stringify(ctx, snapshot, currentGoal) {
  try {
    return JSON.stringify(build(ctx, snapshot, currentGoal));
  } catch (_) {
    return '{}';
  }
}

module.exports = { build, stringify };
