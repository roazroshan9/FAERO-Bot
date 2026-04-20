/**
 * FAERO — Role-Based Access Control (RBAC)
 *
 * Single source of truth for permissions on both Discord and in-game.
 * Changes to env vars take effect immediately (no restart needed for
 * env-var changes). File overrides (roles.json) can be reloaded at
 * runtime with reloadRoles() or via the !bot reload Discord command.
 *
 * TIER HIERARCHY
 *   NONE  (0) — unknown user, all commands denied
 *   MOD   (1) — moderator, utility commands only
 *   OWNER (2) — full access to all commands
 *
 * SETUP ENV VARS (add to Replit Secrets)
 *   OWNER_DISCORD_ID       — your 18-digit Discord user ID
 *   OWNER_MC_NAME          — your Minecraft username (defaults to AUTHORIZED_USER)
 *   MODERATOR_DISCORD_IDS  — comma-separated Discord user IDs
 *   MODERATOR_MC_NAMES     — comma-separated Minecraft usernames
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Tiers ────────────────────────────────────────────────────────────────────

const TIERS = Object.freeze({ NONE: 0, MOD: 1, OWNER: 2 });

// ─── Permission Maps ──────────────────────────────────────────────────────────
// Every command key maps to the MINIMUM tier required to execute it.
// Any command NOT listed here defaults to OWNER (safest default).

const DISCORD_PERMISSIONS = Object.freeze({
  // MOD + OWNER
  help:          TIERS.MOD,
  status:        TIERS.MOD,
  health:        TIERS.MOD,
  logs:          TIERS.MOD,
  // OWNER only (admin / resource management)
  chat:          TIERS.OWNER,
  follow:        TIERS.OWNER,
  stop:          TIERS.OWNER,
  go:            TIERS.OWNER,
  connect:       TIERS.OWNER,
  disconnect:    TIERS.OWNER,
  ai:            TIERS.OWNER,
  resources:     TIERS.OWNER,
  mem:           TIERS.OWNER,
  memory:        TIERS.OWNER,
  // Plugin management — OWNER only
  plugins:       TIERS.OWNER,
  plugin:        TIERS.OWNER,
  // Role management — OWNER only
  roles:         TIERS.OWNER,
  reload:        TIERS.OWNER,
  'add-mod':     TIERS.OWNER,
  'remove-mod':  TIERS.OWNER,
  'add-mcmod':   TIERS.OWNER,
  'remove-mcmod':TIERS.OWNER
});

const MC_PERMISSIONS = Object.freeze({
  // MOD + OWNER
  help:       TIERS.MOD,
  status:     TIERS.MOD,
  follow:     TIERS.MOD,
  come:       TIERS.MOD,
  // OWNER only
  stop:       TIERS.OWNER,
  protect:    TIERS.OWNER,
  goto:       TIERS.OWNER,
  attack:     TIERS.OWNER,
  mine_block: TIERS.OWNER,
  mine_iron:  TIERS.OWNER,
  mine_area:  TIERS.OWNER,
  wood:       TIERS.OWNER,
  eat:        TIERS.OWNER,
  food:       TIERS.OWNER,
  pay:        TIERS.OWNER,
  balance:    TIERS.OWNER,
  jump:       TIERS.OWNER,
  look:       TIERS.OWNER
});

// ─── File Overrides ───────────────────────────────────────────────────────────
// Stored in config/roles.json — updated by role-management Discord commands.
// Keys: ownerDiscordId, ownerMcName, modDiscordIds[], modMcNames[]

const OVERRIDE_FILE = path.join(__dirname, 'roles.json');
let _overrides = {};

function _loadOverrides() {
  try {
    if (fs.existsSync(OVERRIDE_FILE)) {
      _overrides = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
    } else {
      _overrides = {};
    }
  } catch (err) {
    console.error('[roles] Failed to read roles.json:', err.message);
    _overrides = {};
  }
}

_loadOverrides();

// ─── Public API ───────────────────────────────────────────────────────────────

/** Hot-reload overrides from disk (no restart needed). */
function reloadRoles() {
  _loadOverrides();
}

/** Persist a partial update to roles.json and reload. */
function saveOverrides(patch) {
  _loadOverrides();
  const merged = Object.assign({}, _overrides, patch);
  fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(merged, null, 2), 'utf8');
  _overrides = merged;
}

/** Return the merged config: file overrides take priority over env vars. */
function getConfig() {
  return {
    ownerDiscordId: _overrides.ownerDiscordId
      || process.env.OWNER_DISCORD_ID
      || '',

    ownerMcName:    _overrides.ownerMcName
      || process.env.OWNER_MC_NAME
      || process.env.AUTHORIZED_USER
      || 'roaz',

    modDiscordIds: Array.isArray(_overrides.modDiscordIds)
      ? _overrides.modDiscordIds
      : (process.env.MODERATOR_DISCORD_IDS || '').split(',').map(s => s.trim()).filter(Boolean),

    modMcNames: Array.isArray(_overrides.modMcNames)
      ? _overrides.modMcNames
      : (process.env.MODERATOR_MC_NAMES || '').split(',').map(s => s.trim()).filter(Boolean)
  };
}

/** Tier for a Discord user ID. Re-reads config on every call (dynamic). */
function getDiscordTier(userId) {
  if (!userId) return TIERS.NONE;
  const cfg = getConfig();
  if (!cfg.ownerDiscordId) {
    // OWNER_DISCORD_ID not configured — log once and grant no implicit access
    return TIERS.NONE;
  }
  if (userId === cfg.ownerDiscordId) return TIERS.OWNER;
  if (cfg.modDiscordIds.includes(userId)) return TIERS.MOD;
  return TIERS.NONE;
}

/** Tier for a Minecraft username. Re-reads config on every call (dynamic). */
function getMcTier(username) {
  if (!username) return TIERS.NONE;
  const cfg = getConfig();
  if (username === cfg.ownerMcName) return TIERS.OWNER;
  if (cfg.modMcNames.includes(username)) return TIERS.MOD;
  return TIERS.NONE;
}

/** True if a Discord user can run `cmd`. */
function canDiscord(userId, cmd) {
  const cfg = getConfig();
  if (!cfg.ownerDiscordId) {
    // RBAC not fully configured — open access with warning
    return true;
  }
  const userTier    = getDiscordTier(userId);
  const required    = DISCORD_PERMISSIONS[cmd] !== undefined
    ? DISCORD_PERMISSIONS[cmd]
    : TIERS.OWNER;
  return userTier >= required;
}

/** True if a Minecraft player can run `cmd`. */
function canMinecraft(username, cmd) {
  const userTier = getMcTier(username);
  if (userTier === TIERS.NONE) return false;
  const required = MC_PERMISSIONS[cmd] !== undefined
    ? MC_PERMISSIONS[cmd]
    : TIERS.OWNER;
  return userTier >= required;
}

/** Human-readable tier name. */
function tierName(tier) {
  if (tier === TIERS.OWNER) return 'Owner';
  if (tier === TIERS.MOD)   return 'Moderator';
  return 'None';
}

module.exports = {
  TIERS,
  DISCORD_PERMISSIONS,
  MC_PERMISSIONS,
  getConfig,
  reloadRoles,
  saveOverrides,
  getDiscordTier,
  getMcTier,
  canDiscord,
  canMinecraft,
  tierName
};
