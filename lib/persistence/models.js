'use strict';

/**
 * Mongoose schemas for FAERO persistence.
 *
 *   UserRoles      — OWNER / ADMIN / MANAGER lists, mirrored from config/roles.json
 *   SavedLocations — !sethome waypoints, scoped to bot username + label
 *   Logs           — security & command audit history
 *
 * All write helpers degrade gracefully when MongoDB is offline (no-op + false).
 */

const mongoose = require('mongoose');
const mongo    = require('./mongo');

// ── UserRoles ────────────────────────────────────────────────────────────────
const UserRoleSchema = new mongoose.Schema({
  scope:        { type: String, enum: ['discord', 'mc'], required: true, index: true },
  identifier:   { type: String, required: true, index: true },
  tier:         { type: String, enum: ['OWNER', 'ADMIN', 'MANAGER'], required: true },
  addedBy:      { type: String, default: 'system' },
  createdAt:    { type: Date, default: Date.now }
}, { collection: 'faero_user_roles' });
UserRoleSchema.index({ scope: 1, identifier: 1 }, { unique: true });

// ── SavedLocations ───────────────────────────────────────────────────────────
const SavedLocationSchema = new mongoose.Schema({
  owner:     { type: String, required: true, index: true }, // MC username
  label:     { type: String, required: true, default: 'home' },
  x:         { type: Number, required: true },
  y:         { type: Number, required: true },
  z:         { type: Number, required: true },
  dimension: { type: String, default: 'overworld' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'faero_saved_locations' });
SavedLocationSchema.index({ owner: 1, label: 1 }, { unique: true });

// ── Logs ─────────────────────────────────────────────────────────────────────
const LogSchema = new mongoose.Schema({
  type:    { type: String, enum: ['security', 'command', 'system', 'alert'], required: true, index: true },
  level:   { type: String, enum: ['info', 'warn', 'error', 'critical'], default: 'info', index: true },
  actor:   { type: String, default: 'system' },
  message: { type: String, required: true },
  meta:    { type: mongoose.Schema.Types.Mixed, default: null },
  at:      { type: Date, default: Date.now, index: true }
}, { collection: 'faero_logs' });
LogSchema.index({ at: -1 });

// ── DeathLog ─────────────────────────────────────────────────────────────────
const DeathLogSchema = new mongoose.Schema({
  botName:   { type: String, required: true, index: true },
  x:         { type: Number, required: true },
  y:         { type: Number, required: true },
  z:         { type: Number, required: true },
  dimension: { type: String, default: 'overworld' },
  cause:     { type: String, default: 'unknown' },
  recovered: { type: Boolean, default: false },
  at:        { type: Date, default: Date.now, index: true }
}, { collection: 'faero_death_log' });
DeathLogSchema.index({ at: -1 });

// ── PlayerMemory (Neural Social Engine) ──────────────────────────────────────
const PlayerMemorySchema = new mongoose.Schema({
  username:         { type: String, required: true, unique: true, index: true },
  rapportScore:     { type: Number, default: 0 },
  interactionCount: { type: Number, default: 0 },
  lastSeen:         { type: Date,   default: null },
  history: [{
    role:    { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    at:      { type: Date,   default: Date.now }
  }],
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'faero_player_memory' });
PlayerMemorySchema.index({ rapportScore: 1 });

// ── ResourceFind (World Oracle) ───────────────────────────────────────────────
const ResourceFindSchema = new mongoose.Schema({
  type:      { type: String, required: true, index: true },
  family:    { type: String, required: true, index: true },
  x:         { type: Number, required: true },
  y:         { type: Number, required: true },
  z:         { type: Number, required: true },
  chunkX:    { type: Number, required: true },
  chunkZ:    { type: Number, required: true },
  dimension: { type: String, default: 'overworld', index: true },
  foundAt:   { type: Date,   default: Date.now, index: true }
}, { collection: 'faero_resource_finds' });
ResourceFindSchema.index({ family: 1, dimension: 1, foundAt: -1 });

// ── ExploredChunk (World Oracle) ─────────────────────────────────────────────
const ExploredChunkSchema = new mongoose.Schema({
  chunkX:     { type: Number, required: true },
  chunkZ:     { type: Number, required: true },
  dimension:  { type: String, default: 'overworld', index: true },
  biome:      { type: String, default: null },
  firstSeen:  { type: Date,   default: Date.now },
  lastSeen:   { type: Date,   default: Date.now },
  visitCount: { type: Number, default: 1 }
}, { collection: 'faero_explored_chunks' });
ExploredChunkSchema.index({ chunkX: 1, chunkZ: 1, dimension: 1 }, { unique: true });

// ── PlayerBehavior (World Oracle) ─────────────────────────────────────────────
const PlayerBehaviorSchema = new mongoose.Schema({
  username:     { type: String, required: true, unique: true, index: true },
  zones:        [{ rk: String, x: Number, z: Number, count: Number }],
  styleSignals: {
    miner:    { type: Number, default: 0 },
    fighter:  { type: Number, default: 0 },
    explorer: { type: Number, default: 0 },
    trader:   { type: Number, default: 0 }
  },
  sightingCount: { type: Number, default: 0 },
  lastSeen:      { type: Date,   default: null },
  dimension:     { type: String, default: 'overworld' },
  updatedAt:     { type: Date,   default: Date.now }
}, { collection: 'faero_player_behavior' });

const UserRole       = mongoose.model('FaeroUserRole', UserRoleSchema);
const SavedLocation  = mongoose.model('FaeroSavedLocation', SavedLocationSchema);
const LogEntry       = mongoose.model('FaeroLog', LogSchema);
const DeathLog       = mongoose.model('FaeroDeathLog', DeathLogSchema);
const PlayerMemory   = mongoose.model('FaeroPlayerMemory', PlayerMemorySchema);
const ResourceFind   = mongoose.model('FaeroResourceFind',   ResourceFindSchema);
const ExploredChunk  = mongoose.model('FaeroExploredChunk',  ExploredChunkSchema);
const PlayerBehavior = mongoose.model('FaeroPlayerBehavior', PlayerBehaviorSchema);

// ── Safe write helpers (no-op when offline) ──────────────────────────────────

async function writeLog(entry) {
  if (!mongo.isReady()) return false;
  try {
    await LogEntry.create(entry);
    return true;
  } catch (_) { return false; }
}

async function upsertLocation(loc) {
  if (!mongo.isReady()) return false;
  try {
    await SavedLocation.updateOne(
      { owner: loc.owner, label: loc.label || 'home' },
      { $set: { x: loc.x, y: loc.y, z: loc.z, dimension: loc.dimension || 'overworld', updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    return true;
  } catch (_) { return false; }
}

async function findLocation(owner, label) {
  if (!mongo.isReady()) return null;
  try {
    return await SavedLocation.findOne({ owner, label: label || 'home' }).lean();
  } catch (_) { return null; }
}

async function listLocations(owner) {
  if (!mongo.isReady()) return [];
  try {
    const filter = owner ? { owner } : {};
    return await SavedLocation.find(filter).sort({ label: 1 }).lean();
  } catch (_) { return []; }
}

async function deleteLocation(owner, label) {
  if (!mongo.isReady()) return { ok: false, reason: 'offline' };
  try {
    const r = await SavedLocation.deleteOne({ owner, label });
    return { ok: r.deletedCount > 0, reason: r.deletedCount > 0 ? 'deleted' : 'not_found' };
  } catch (err) {
    return { ok: false, reason: 'error:' + (err && err.message ? err.message : 'unknown') };
  }
}

async function syncRoleSnapshot(rolesConfig) {
  if (!mongo.isReady()) return false;
  try {
    const ops = [];
    const push = (scope, identifier, tier) => {
      if (!identifier) return;
      ops.push({
        updateOne: {
          filter: { scope, identifier },
          update: { $set: { tier }, $setOnInsert: { createdAt: new Date(), addedBy: 'sync' } },
          upsert: true
        }
      });
    };
    push('discord', rolesConfig.ownerDiscordId, 'OWNER');
    push('mc',      rolesConfig.ownerMcName,    'OWNER');
    (rolesConfig.adminDiscordIds   || []).forEach(id => push('discord', id, 'ADMIN'));
    (rolesConfig.adminMcNames      || []).forEach(n  => push('mc', n,  'ADMIN'));
    (rolesConfig.managerDiscordIds || []).forEach(id => push('discord', id, 'MANAGER'));
    (rolesConfig.managerMcNames    || []).forEach(n  => push('mc', n,  'MANAGER'));
    if (ops.length > 0) await UserRole.bulkWrite(ops, { ordered: false });
    return true;
  } catch (_) { return false; }
}

async function logDeath(entry) {
  if (!mongo.isReady()) return null;
  try {
    const doc = await DeathLog.create({
      botName:   entry.botName   || 'faero',
      x:         entry.x,
      y:         entry.y,
      z:         entry.z,
      dimension: entry.dimension || 'overworld',
      cause:     entry.cause     || 'unknown'
    });
    return doc._id;
  } catch (_) { return null; }
}

async function listDeaths(botName, limit) {
  if (!mongo.isReady()) return [];
  try {
    const filter = botName ? { botName } : {};
    return await DeathLog.find(filter)
      .sort({ at: -1 })
      .limit(limit || 20)
      .lean();
  } catch (_) { return []; }
}

async function markDeathRecovered(id) {
  if (!mongo.isReady() || !id) return false;
  try {
    await DeathLog.updateOne({ _id: id }, { $set: { recovered: true } });
    return true;
  } catch (_) { return false; }
}

// ── PlayerMemory helpers (Neural Social Engine) ───────────────────────────────

// ── World Oracle helpers ──────────────────────────────────────────────────────

async function insertResourceFind(entry) {
  if (!mongo.isReady()) return false;
  try {
    await ResourceFind.create({
      type:      entry.type,
      family:    entry.family,
      x:         entry.x,
      y:         entry.y,
      z:         entry.z,
      chunkX:    entry.chunkX,
      chunkZ:    entry.chunkZ,
      dimension: entry.dimension || 'overworld',
      foundAt:   entry.foundAt ? new Date(entry.foundAt) : new Date()
    });
    return true;
  } catch (_) { return false; }
}

async function listResourceFinds(limit, family) {
  if (!mongo.isReady()) return [];
  try {
    const filter = family ? { family } : {};
    return await ResourceFind.find(filter)
      .sort({ foundAt: -1 })
      .limit(limit || 500)
      .lean();
  } catch (_) { return []; }
}

async function upsertExploredChunk(chunk) {
  if (!mongo.isReady()) return false;
  try {
    await ExploredChunk.updateOne(
      { chunkX: chunk.chunkX, chunkZ: chunk.chunkZ, dimension: chunk.dimension || 'overworld' },
      {
        $set:         { lastSeen: new Date(), biome: chunk.biome || null },
        $inc:         { visitCount: 1 },
        $setOnInsert: { firstSeen: new Date(chunk.firstSeen || Date.now()) }
      },
      { upsert: true }
    );
    return true;
  } catch (_) { return false; }
}

async function listExploredChunks(limit) {
  if (!mongo.isReady()) return [];
  try {
    return await ExploredChunk.find({})
      .sort({ lastSeen: -1 })
      .limit(limit || 5000)
      .lean();
  } catch (_) { return []; }
}

async function upsertPlayerBehavior(profile) {
  if (!mongo.isReady()) return false;
  try {
    await PlayerBehavior.updateOne(
      { username: profile.username },
      {
        $set: {
          zones:         profile.zones        || [],
          styleSignals:  profile.styleSignals || {},
          sightingCount: profile.sightingCount || 0,
          lastSeen:      profile.lastSeen ? new Date(profile.lastSeen) : null,
          dimension:     profile.dimension || 'overworld',
          updatedAt:     new Date()
        }
      },
      { upsert: true }
    );
    return true;
  } catch (_) { return false; }
}

async function listPlayerBehaviors() {
  if (!mongo.isReady()) return [];
  try {
    return await PlayerBehavior.find({})
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();
  } catch (_) { return []; }
}

async function getPlayerMemory(username) {
  if (!mongo.isReady()) return null;
  try {
    return await PlayerMemory.findOne({ username }).lean();
  } catch (_) { return null; }
}

async function upsertPlayerMemory(data) {
  if (!mongo.isReady()) return false;
  try {
    await PlayerMemory.updateOne(
      { username: data.username },
      {
        $set: {
          rapportScore:     data.rapportScore     ?? 0,
          interactionCount: data.interactionCount ?? 0,
          lastSeen:         data.lastSeen         ? new Date(data.lastSeen) : null,
          history:          Array.isArray(data.history) ? data.history : [],
          updatedAt:        new Date()
        }
      },
      { upsert: true }
    );
    return true;
  } catch (_) { return false; }
}

async function listPlayerMemories(limit) {
  if (!mongo.isReady()) return [];
  try {
    return await PlayerMemory.find({})
      .sort({ updatedAt: -1 })
      .limit(limit || 50)
      .lean();
  } catch (_) { return []; }
}

async function deletePlayerMemory(username) {
  if (!mongo.isReady()) return false;
  try {
    await PlayerMemory.deleteOne({ username });
    return true;
  } catch (_) { return false; }
}

module.exports = {
  UserRole,
  SavedLocation,
  LogEntry,
  DeathLog,
  PlayerMemory,
  writeLog,
  upsertLocation,
  findLocation,
  listLocations,
  deleteLocation,
  syncRoleSnapshot,
  logDeath,
  listDeaths,
  markDeathRecovered,
  getPlayerMemory,
  upsertPlayerMemory,
  listPlayerMemories,
  deletePlayerMemory,
  insertResourceFind,
  listResourceFinds,
  upsertExploredChunk,
  listExploredChunks,
  upsertPlayerBehavior,
  listPlayerBehaviors
};
