/**
 * FAERO — Role-Based Access Control (RBAC)
 *
 * Single source of truth for permissions on both Discord and in-game.
 * Changes to env vars take effect immediately (no restart needed).
 * File overrides (roles.json) can be reloaded at runtime via reloadRoles().
 *
 * TIER HIERARCHY (strictly ordered)
 *   NONE    (0) — unknown user, all commands denied
 *   MANAGER (1) — operational permissions only (mine, move, follow)
 *                 cannot run any role-management commands
 *   ADMIN   (2) — full functional access + can manage Managers
 *                 cannot add/remove other Admins or the Owner
 *   OWNER   (3) — unrestricted access, manages all roles
 *
 * SETUP ENV VARS (add to Replit Secrets)
 *   OWNER_DISCORD_ID       — your 18-digit Discord user ID
 *   OWNER_MC_NAME          — your Minecraft username (defaults to AUTHORIZED_USER)
 *   ADMIN_DISCORD_IDS      — comma-separated Admin Discord user IDs
 *   ADMIN_MC_NAMES         — comma-separated Admin Minecraft usernames
 *   MANAGER_DISCORD_IDS    — comma-separated Manager Discord user IDs (was MODERATOR_DISCORD_IDS)
 *   MANAGER_MC_NAMES       — comma-separated Manager Minecraft usernames (was MODERATOR_MC_NAMES)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Tiers ────────────────────────────────────────────────────────────────────

const TIERS = Object.freeze({
  NONE:    0,
  MANAGER: 1,
  MOD:     1,  // backward-compat alias for MANAGER
  ADMIN:   2,
  OWNER:   3
});

// ─── Permission Maps ──────────────────────────────────────────────────────────
// Every key maps to the MINIMUM tier required to execute that command.
// Any command NOT listed here defaults to OWNER (safest default).

const DISCORD_PERMISSIONS = Object.freeze({
  // ── MANAGER + ADMIN + OWNER ──────────────────────────────────────────────
  help:              TIERS.MANAGER,
  status:            TIERS.MANAGER,
  health:            TIERS.MANAGER,
  logs:              TIERS.MANAGER,
  waypoints:         TIERS.MANAGER,

  // ── ADMIN + OWNER ────────────────────────────────────────────────────────
  chat:              TIERS.ADMIN,
  follow:            TIERS.ADMIN,
  stop:              TIERS.ADMIN,
  go:                TIERS.ADMIN,
  // Manager role management (ADMIN can manage Managers)
  'add-manager':     TIERS.ADMIN,
  'remove-manager':  TIERS.ADMIN,
  'add-mcmanager':   TIERS.ADMIN,
  'remove-mcmanager':TIERS.ADMIN,

  // ── OWNER only ───────────────────────────────────────────────────────────
  connect:           TIERS.OWNER,
  disconnect:        TIERS.OWNER,
  ai:                TIERS.OWNER,
  resources:         TIERS.OWNER,
  mem:               TIERS.OWNER,
  memory:            TIERS.OWNER,
  plugins:           TIERS.OWNER,
  plugin:            TIERS.OWNER,
  roles:             TIERS.OWNER,
  reload:            TIERS.OWNER,
  // Admin role management (OWNER only)
  'add-admin':       TIERS.OWNER,
  'remove-admin':    TIERS.OWNER,
  'add-mcadmin':     TIERS.OWNER,
  'remove-mcadmin':  TIERS.OWNER,
  // Legacy aliases (kept for backward compat, map to manager tier)
  'add-mod':         TIERS.OWNER,
  'remove-mod':      TIERS.OWNER,
  'add-mcmod':       TIERS.OWNER,
  'remove-mcmod':    TIERS.OWNER
});

const MC_PERMISSIONS = Object.freeze({
  // ── MANAGER + ADMIN + OWNER ──────────────────────────────────────────────
  help:           TIERS.MANAGER,
  status:         TIERS.MANAGER,
  follow:         TIERS.MANAGER,
  come:           TIERS.MANAGER,
  mineblock:      TIERS.MANAGER,  // renamed from mine_block
  mine_iron:      TIERS.MANAGER,
  wood:           TIERS.MANAGER,
  eat:            TIERS.MANAGER,
  food:           TIERS.MANAGER,
  // AI Modes
  mode:           TIERS.MANAGER,
  // Inventory
  inv:            TIERS.MANAGER,
  equip:          TIERS.MANAGER,
  // Combat & Movement
  pvp_toggle:     TIERS.MANAGER,
  target_mob:     TIERS.MANAGER,
  retreat:        TIERS.MANAGER,
  sethome:        TIERS.MANAGER,
  home:           TIERS.MANAGER,
  tp:             TIERS.MANAGER,
  wander:         TIERS.MANAGER,
  // Debug & Dev
  tasklist:       TIERS.MANAGER,
  debug:          TIERS.MANAGER,

  // ── ADMIN + OWNER ────────────────────────────────────────────────────────
  stop:           TIERS.ADMIN,
  protect:        TIERS.ADMIN,
  goto:           TIERS.ADMIN,
  attack:         TIERS.ADMIN,
  pay:            TIERS.ADMIN,
  balance:        TIERS.ADMIN,
  jump:           TIERS.ADMIN,
  look:           TIERS.ADMIN,
  minearea:       TIERS.ADMIN,  // renamed from mine_area
  give:           TIERS.ADMIN,
  // Inventory (Admin+)
  dropall:        TIERS.ADMIN,
  store:          TIERS.ADMIN,
  sort:           TIERS.MANAGER,
  waypoint:       TIERS.MANAGER,
  // Building
  build:          TIERS.ADMIN,
  // Debug (Admin+)
  cleartasks:     TIERS.ADMIN,
  log_view:       TIERS.ADMIN,
  // Manager role management (ADMIN+)
  add_manager:    TIERS.ADMIN,
  remove_manager: TIERS.ADMIN,

  // ── AI Brain (LLM) ───────────────────────────────────────────────────────
  ai_goal:        TIERS.MANAGER,
  ai_stop:        TIERS.MANAGER,
  ai_chat:        TIERS.OWNER,

  // ── OWNER only ───────────────────────────────────────────────────────────
  add_admin:      TIERS.OWNER,
  remove_admin:   TIERS.OWNER
});

// ─── File Overrides ───────────────────────────────────────────────────────────
// Stored in config/roles.json — updated by role-management commands.
// Schema: { ownerDiscordId, ownerMcName,
//           adminDiscordIds[], adminMcNames[],
//           managerDiscordIds[], managerMcNames[] }

const OVERRIDE_FILE = path.join(__dirname, 'roles.json');
let _overrides = {};

function _loadOverrides() {
  try {
    if (fs.existsSync(OVERRIDE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
      // ── Migrate legacy keys (modDiscordIds → managerDiscordIds) ──────────
      if (!raw.managerDiscordIds && raw.modDiscordIds) {
        raw.managerDiscordIds = raw.modDiscordIds;
      }
      if (!raw.managerMcNames && raw.modMcNames) {
        raw.managerMcNames = raw.modMcNames;
      }
      _overrides = raw;
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

/**
 * Append a value to a named list in roles.json.
 * Returns true if the value was added, false if it was already present.
 */
function addToRole(field, value) {
  _loadOverrides();
  const arr = Array.isArray(_overrides[field]) ? _overrides[field] : [];
  if (arr.includes(value)) return false;
  saveOverrides({ [field]: [...arr, value] });
  return true;
}

/**
 * Remove a value from a named list in roles.json.
 * Returns true if the value was removed, false if it was not found.
 */
function removeFromRole(field, value) {
  _loadOverrides();
  const arr = Array.isArray(_overrides[field]) ? _overrides[field] : [];
  if (!arr.includes(value)) return false;
  saveOverrides({ [field]: arr.filter(v => v !== value) });
  return true;
}

/**
 * Returns true if actorTier is strictly higher than targetTier.
 * Used to verify a user can only modify roles below their own level.
 */
function canModifyTier(actorTier, targetTier) {
  return actorTier > targetTier;
}

/** Return the merged config: file overrides take priority over env vars. */
function getConfig() {
  return {
    ownerDiscordId: _overrides.ownerDiscordId
      || process.env.OWNER_DISCORD_ID
      || '',

    ownerMcName: _overrides.ownerMcName
      || process.env.OWNER_MC_NAME
      || process.env.AUTHORIZED_USER
      || 'roaz',

    adminDiscordIds: Array.isArray(_overrides.adminDiscordIds)
      ? _overrides.adminDiscordIds
      : (process.env.ADMIN_DISCORD_IDS || '').split(',').map(s => s.trim()).filter(Boolean),

    adminMcNames: Array.isArray(_overrides.adminMcNames)
      ? _overrides.adminMcNames
      : (process.env.ADMIN_MC_NAMES || '').split(',').map(s => s.trim()).filter(Boolean),

    managerDiscordIds: Array.isArray(_overrides.managerDiscordIds)
      ? _overrides.managerDiscordIds
      : (process.env.MANAGER_DISCORD_IDS || process.env.MODERATOR_DISCORD_IDS || '')
          .split(',').map(s => s.trim()).filter(Boolean),

    managerMcNames: Array.isArray(_overrides.managerMcNames)
      ? _overrides.managerMcNames
      : (process.env.MANAGER_MC_NAMES || process.env.MODERATOR_MC_NAMES || '')
          .split(',').map(s => s.trim()).filter(Boolean),

    // ── Legacy aliases ─────────────────────────────────────────────────────
    get modDiscordIds() { return this.managerDiscordIds; },
    get modMcNames()    { return this.managerMcNames;    }
  };
}

/** Tier for a Discord user ID. Re-reads config on every call (dynamic). */
function getDiscordTier(userId) {
  if (!userId) return TIERS.NONE;
  const cfg = getConfig();
  if (!cfg.ownerDiscordId) return TIERS.NONE;
  if (userId === cfg.ownerDiscordId)          return TIERS.OWNER;
  if (cfg.adminDiscordIds.includes(userId))   return TIERS.ADMIN;
  if (cfg.managerDiscordIds.includes(userId)) return TIERS.MANAGER;
  return TIERS.NONE;
}

/** Tier for a Minecraft username. Re-reads config on every call (dynamic). */
function getMcTier(username) {
  if (!username) return TIERS.NONE;
  const cfg = getConfig();
  if (username === cfg.ownerMcName)       return TIERS.OWNER;
  if (cfg.adminMcNames.includes(username))   return TIERS.ADMIN;
  if (cfg.managerMcNames.includes(username)) return TIERS.MANAGER;
  return TIERS.NONE;
}

/** True if a Discord user can run `cmd`. */
function canDiscord(userId, cmd) {
  const cfg = getConfig();
  if (!cfg.ownerDiscordId) return true; // RBAC not configured — open with warning
  const userTier = getDiscordTier(userId);
  const required = DISCORD_PERMISSIONS[cmd] !== undefined
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
  if (tier === TIERS.OWNER)   return 'Owner';
  if (tier === TIERS.ADMIN)   return 'Admin';
  if (tier === TIERS.MANAGER) return 'Manager';
  return 'None';
}

module.exports = {
  TIERS,
  DISCORD_PERMISSIONS,
  MC_PERMISSIONS,
  getConfig,
  reloadRoles,
  saveOverrides,
  addToRole,
  removeFromRole,
  canModifyTier,
  getDiscordTier,
  getMcTier,
  canDiscord,
  canMinecraft,
  tierName
};
