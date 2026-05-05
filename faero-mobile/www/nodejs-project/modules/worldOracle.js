'use strict';

/**
 * FAERO — Adaptive World Oracle (modules/worldOracle.js)
 *
 * Module 5: The bot learns the server map, profiles player behaviours,
 * and predicts where resources will spawn next.
 *
 * Three subsystems:
 *
 *   1. TERRAIN MEMORY
 *      Tracks every chunk the bot loads. Maintains an in-memory
 *      grid (chunkX, chunkZ) with visit counts, biome, and first/last seen.
 *      Persists to MongoDB every 90 s.
 *
 *   2. RESOURCE ORACLE
 *      Logs every ore / valuable block discovered (by scanner or by mining).
 *      Builds a spatial density model to predict the most likely coordinates
 *      for each resource type. Confidence = normalised density × recency.
 *
 *   3. PLAYER BEHAVIOUR PROFILER
 *      Samples nearby player positions every 30 s.  Clusters sightings into
 *      home zones, tallies activity signals from social-engine chat keywords,
 *      and infers a play style (MINER / FIGHTER / EXPLORER / TRADER / UNKNOWN).
 */

const mongo  = require('../lib/persistence/mongo');
const models = require('../lib/persistence/models');

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_CHUNKS_MEM      = 12000; // evict oldest when over limit
const MAX_FINDS_MEM       = 6000;  // cap resource-find entries
const MAX_PLAYER_ZONES    = 200;   // player zone sightings kept per username
const FLUSH_INTERVAL_MS   = 90000; // persist dirty data every 90 s
const PLAYER_SAMPLE_MS    = 30000; // sample nearby players every 30 s
const HOTSPOT_REGION_SIZE = 32;    // 32-block square = 2×2 chunks

const ORE_FAMILIES = {
  diamond:   ['diamond_ore',  'deepslate_diamond_ore'],
  iron:      ['iron_ore',     'deepslate_iron_ore'],
  gold:      ['gold_ore',     'deepslate_gold_ore'],
  coal:      ['coal_ore',     'deepslate_coal_ore'],
  copper:    ['copper_ore',   'deepslate_copper_ore'],
  redstone:  ['redstone_ore', 'deepslate_redstone_ore'],
  lapis:     ['lapis_ore',    'deepslate_lapis_ore'],
  emerald:   ['emerald_ore',  'deepslate_emerald_ore'],
  ancient_debris: ['ancient_debris'],
  nether_gold:    ['nether_gold_ore'],
  quartz:    ['quartz_ore'],
  chest:     ['chest', 'barrel', 'trapped_chest'],
  spawner:   ['spawner'],
};

// Reverse lookup: block name → family name
const _blockToFamily = {};
for (const [family, names] of Object.entries(ORE_FAMILIES)) {
  for (const name of names) _blockToFamily[name] = family;
}

// Play-style keyword signals
const STYLE_SIGNALS = {
  miner:    ['mine', 'ore', 'dig', 'diamond', 'iron', 'coal', 'pickaxe', 'strip'],
  fighter:  ['kill', 'pvp', 'fight', 'sword', 'attack', 'combat', 'war', 'raid'],
  explorer: ['explore', 'map', 'biome', 'travel', 'wander', 'discover', 'far', 'elytra'],
  trader:   ['trade', 'buy', 'sell', 'shop', 'price', 'emerald', 'villager', 'market'],
};

// ── In-memory stores ──────────────────────────────────────────────────────────

// Map<chunkKey → ChunkRecord>
//   ChunkRecord: { chunkX, chunkZ, dimension, biome, firstSeen, lastSeen, visitCount, dirty }
const _chunks = new Map();

// Array of ResourceFind records (newest-last ring buffer)
//   ResourceFind: { type, family, x, y, z, chunkX, chunkZ, dimension, foundAt }
const _finds = [];

// Map<username → PlayerProfile>
//   PlayerProfile: { username, zones: [{rX, rZ, count}], styleSignals: {miner,fighter,explorer,trader},
//                   lastSeen, sightingCount, dirty }
const _players = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function _chunkKey(chunkX, chunkZ, dimension) {
  return chunkX + ':' + chunkZ + ':' + (dimension || 'overworld');
}

function _regionKey(x, z) {
  return Math.floor(x / HOTSPOT_REGION_SIZE) + ':' + Math.floor(z / HOTSPOT_REGION_SIZE);
}

function _regionCenter(regionKey) {
  const [rx, rz] = regionKey.split(':').map(Number);
  return {
    x: rx * HOTSPOT_REGION_SIZE + Math.floor(HOTSPOT_REGION_SIZE / 2),
    z: rz * HOTSPOT_REGION_SIZE + Math.floor(HOTSPOT_REGION_SIZE / 2)
  };
}

function _msSince(isoStr) {
  return Date.now() - new Date(isoStr).getTime();
}

// ── 1. TERRAIN MEMORY ─────────────────────────────────────────────────────────

/**
 * Record that a chunk has been loaded/explored.
 * @param {number} chunkX
 * @param {number} chunkZ
 * @param {object} [opts] — { dimension, biome }
 */
function recordChunkExplored(chunkX, chunkZ, opts) {
  const dim = (opts && opts.dimension) || 'overworld';
  const key = _chunkKey(chunkX, chunkZ, dim);

  if (_chunks.has(key)) {
    const c = _chunks.get(key);
    c.visitCount++;
    c.lastSeen = new Date().toISOString();
    if (opts && opts.biome && !c.biome) c.biome = opts.biome;
    c.dirty = true;
    return;
  }

  // Evict oldest if over limit
  if (_chunks.size >= MAX_CHUNKS_MEM) {
    const oldestKey = _chunks.keys().next().value;
    _chunks.delete(oldestKey);
  }

  _chunks.set(key, {
    chunkX, chunkZ,
    dimension:  dim,
    biome:      (opts && opts.biome) || null,
    firstSeen:  new Date().toISOString(),
    lastSeen:   new Date().toISOString(),
    visitCount: 1,
    dirty: true
  });
}

function getExplorationStats() {
  const byDim = {};
  for (const c of _chunks.values()) {
    const d = c.dimension || 'overworld';
    if (!byDim[d]) byDim[d] = 0;
    byDim[d]++;
  }
  const total = _chunks.size;
  const approxBlocksExplored = total * 256; // 16×16 per chunk
  return {
    totalChunks: total,
    approxBlockArea: approxBlocksExplored,
    byDimension: byDim,
    resourceFinds: _finds.length
  };
}

// ── 2. RESOURCE ORACLE ────────────────────────────────────────────────────────

/**
 * Log a resource/ore discovery.
 * @param {string} blockType — exact Minecraft block name
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {object} [opts] — { dimension }
 */
function recordResourceFind(blockType, x, y, z, opts) {
  const family    = _blockToFamily[blockType] || blockType;
  const dimension = (opts && opts.dimension) || 'overworld';
  const chunkX    = Math.floor(x / 16);
  const chunkZ    = Math.floor(z / 16);
  const entry     = {
    type:      blockType,
    family,
    x: Math.round(x),
    y: Math.round(y),
    z: Math.round(z),
    chunkX, chunkZ,
    dimension,
    foundAt: new Date().toISOString()
  };

  _finds.push(entry);
  if (_finds.length > MAX_FINDS_MEM) _finds.shift();

  // Persist to DB asynchronously
  models.insertResourceFind(entry).catch(() => {});
}

/**
 * Predict the top N hotspots for a given resource family.
 * Scoring: finds per region × recency_weight (decays with age).
 *
 * @param {string} family   — ore family name, e.g. 'diamond'
 * @param {number} [limit]  — max results to return (default 5)
 * @returns {Array<{x, y, z, confidence, findCount, lastFound, family}>}
 */
function predictHotspots(family, limit) {
  limit = limit || 5;
  const targets = ORE_FAMILIES[family] || [family];

  // Group finds by 32×32 region
  const regions = new Map();
  for (const f of _finds) {
    if (!targets.includes(f.type)) continue;
    const rk = _regionKey(f.x, f.z);
    if (!regions.has(rk)) regions.set(rk, { finds: [], avgY: 0 });
    regions.get(rk).finds.push(f);
  }

  const now = Date.now();
  const scored = [];

  for (const [rk, data] of regions.entries()) {
    const { finds } = data;
    // Recency-weighted score: each find contributes 1 point, decaying to 0.1 over 24 h
    let score = 0;
    let sumY  = 0;
    let newest = null;
    for (const f of finds) {
      const ageMins  = _msSince(f.foundAt) / 60000;
      const decay    = Math.max(0.1, 1 - ageMins / 1440); // 24h decay
      score += decay;
      sumY  += f.y;
      if (!newest || f.foundAt > newest) newest = f.foundAt;
    }
    const center = _regionCenter(rk);
    scored.push({
      family,
      regionKey: rk,
      x: center.x,
      y: Math.round(sumY / finds.length),
      z: center.z,
      findCount:   finds.length,
      score,
      lastFound:   newest
    });
  }

  // Normalise confidence to 0–100 %
  const maxScore = scored.reduce((m, s) => Math.max(m, s.score), 0.01);
  scored.forEach(s => {
    s.confidence = Math.min(99, Math.round((s.score / maxScore) * 95));
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ regionKey: _rk, score: _s, ...rest }) => rest);
}

/**
 * Get predictions for all ore families at once.
 */
function getAllHotspots(limitPerFamily) {
  const result = {};
  for (const family of Object.keys(ORE_FAMILIES)) {
    result[family] = predictHotspots(family, limitPerFamily || 3);
  }
  return result;
}

/**
 * Get recent resource finds as a flat list (for the dashboard feed).
 */
function getRecentFinds(limit) {
  return _finds.slice(-( limit || 30)).reverse();
}

// ── 3. PLAYER BEHAVIOUR PROFILER ──────────────────────────────────────────────

/**
 * Record a player position sighting (call periodically from botManager).
 * @param {string} username
 * @param {number} x
 * @param {number} z
 * @param {object} [opts] — { dimension }
 */
function recordPlayerSighting(username, x, z, opts) {
  if (!username) return;
  const dim = (opts && opts.dimension) || 'overworld';
  const rk  = _regionKey(x, z);

  if (!_players.has(username)) {
    _players.set(username, {
      username,
      zones: [],          // [{rk, x, z, count}]
      styleSignals: { miner: 0, fighter: 0, explorer: 0, trader: 0 },
      sightingCount: 0,
      lastSeen: null,
      dimension: dim,
      dirty: false
    });
  }

  const profile = _players.get(username);
  profile.sightingCount++;
  profile.lastSeen = new Date().toISOString();
  profile.dimension = dim;
  profile.dirty = true;

  // Update zone count
  const zone = profile.zones.find(z => z.rk === rk);
  if (zone) {
    zone.count++;
  } else {
    const center = _regionCenter(rk);
    profile.zones.push({ rk, x: center.x, z: center.z, count: 1 });
    // Trim to most visited zones
    if (profile.zones.length > MAX_PLAYER_ZONES) {
      profile.zones.sort((a, b) => b.count - a.count);
      profile.zones = profile.zones.slice(0, MAX_PLAYER_ZONES);
    }
  }
}

/**
 * Record a chat-derived activity signal for a player.
 * Called from botManager chat event / socialEngine.
 * @param {string} username
 * @param {string} message — raw chat string
 */
function recordPlayerChatSignal(username, message) {
  if (!username || !message) return;
  const lower = message.toLowerCase();
  if (!_players.has(username)) {
    _players.set(username, {
      username,
      zones: [],
      styleSignals: { miner: 0, fighter: 0, explorer: 0, trader: 0 },
      sightingCount: 0,
      lastSeen: new Date().toISOString(),
      dimension: 'overworld',
      dirty: false
    });
  }
  const profile = _players.get(username);
  for (const [style, keywords] of Object.entries(STYLE_SIGNALS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      profile.styleSignals[style] = (profile.styleSignals[style] || 0) + 1;
      profile.dirty = true;
    }
  }
}

/**
 * Infer play style from signal counts.
 */
function _inferStyle(signals) {
  const total = Object.values(signals).reduce((a, b) => a + b, 0);
  if (!total) return 'UNKNOWN';
  const dominant = Object.entries(signals).sort((a, b) => b[1] - a[1])[0];
  if (dominant[1] < 2) return 'UNKNOWN'; // not enough data
  return dominant[0].toUpperCase();
}

/**
 * Get all player behaviour profiles (enriched with inferred style + home zone).
 */
function getPlayerProfiles() {
  return Array.from(_players.values()).map(p => {
    const homeZone = p.zones.length
      ? p.zones.reduce((best, z) => (!best || z.count > best.count) ? z : best, null)
      : null;
    return {
      username:      p.username,
      playStyle:     _inferStyle(p.styleSignals),
      styleSignals:  p.styleSignals,
      sightingCount: p.sightingCount,
      lastSeen:      p.lastSeen,
      dimension:     p.dimension,
      homeZone:      homeZone ? { x: homeZone.x, z: homeZone.z, visits: homeZone.count } : null,
      topZones:      p.zones.slice().sort((a, b) => b.count - a.count).slice(0, 3).map(z => ({ x: z.x, z: z.z, visits: z.count }))
    };
  });
}

/**
 * Get a single player's profile.
 */
function getPlayerProfile(username) {
  if (!_players.has(username)) return null;
  const p = _players.get(username);
  const homeZone = p.zones.length
    ? p.zones.reduce((best, z) => (!best || z.count > best.count) ? z : best, null)
    : null;
  return {
    username:      p.username,
    playStyle:     _inferStyle(p.styleSignals),
    styleSignals:  p.styleSignals,
    sightingCount: p.sightingCount,
    lastSeen:      p.lastSeen,
    dimension:     p.dimension,
    homeZone:      homeZone ? { x: homeZone.x, z: homeZone.z, visits: homeZone.count } : null,
    topZones:      p.zones.slice().sort((a, b) => b.count - a.count).slice(0, 5).map(z => ({ x: z.x, z: z.z, visits: z.count })),
    allZones:      p.zones.length
  };
}

// ── Attach to a live bot instance (called after spawn) ────────────────────────

/**
 * Attach the World Oracle to a running bot.
 * Wires chunkColumnLoad and a player-sampling interval.
 *
 * @param {object} bot          — mineflayer bot instance
 * @param {object} [opts]
 * @param {Function} [opts.onLog]      — log callback
 * @param {Function} [opts.onOracleEvent] — called with oracle:find events
 */
function attach(bot, opts) {
  const onLog   = opts && typeof opts.onLog   === 'function' ? opts.onLog   : () => {};
  const onEvent = opts && typeof opts.onOracleEvent === 'function' ? opts.onOracleEvent : null;

  // ── Chunk exploration tracking ─────────────────────────────────────────────
  bot.on('chunkColumnLoad', (point) => {
    const chunkX = Math.floor(point.x / 16);
    const chunkZ = Math.floor(point.z / 16);
    recordChunkExplored(chunkX, chunkZ, { dimension: _getBotDimension(bot) });
  });

  // ── Detect when bot completes mining a block ──────────────────────────────
  bot.on('diggingCompleted', (block) => {
    if (!block || !block.position) return;
    const name = block.name || (block.type && bot.registry && bot.registry.blocks[block.type] && bot.registry.blocks[block.type].name);
    if (!name) return;
    if (_blockToFamily[name]) {
      const { x, y, z } = block.position;
      recordResourceFind(name, x, y, z, { dimension: _getBotDimension(bot) });
      onLog('[oracle] Resource mined: ' + name + ' at X' + Math.round(x) + ' Y' + Math.round(y) + ' Z' + Math.round(z));
      if (onEvent) onEvent({ type: 'resource_mined', blockType: name, family: _blockToFamily[name], x: Math.round(x), y: Math.round(y), z: Math.round(z) });
    }
  });

  // ── Periodic player position sampling ─────────────────────────────────────
  const _sampleTimer = setInterval(() => {
    if (!bot || !bot.entity || !bot.players) return;
    const dim = _getBotDimension(bot);
    for (const [name, player] of Object.entries(bot.players)) {
      if (!player || !player.entity || name === bot.username) continue;
      const pos = player.entity.position;
      if (!pos) continue;
      recordPlayerSighting(name, pos.x, pos.z, { dimension: dim });
    }
  }, PLAYER_SAMPLE_MS);

  // Clean up timer if bot disconnects
  bot.once('end', () => clearInterval(_sampleTimer));

  onLog('[oracle] World Oracle attached — tracking chunks, resources, and players');
}

/**
 * Notify oracle of a scanner discovery (plug-in point for scanner.js).
 */
function onScannerFind(blockType, x, y, z, opts) {
  if (_blockToFamily[blockType]) {
    recordResourceFind(blockType, x, y, z, opts);
  }
}

// ── Dimension helper ──────────────────────────────────────────────────────────

function _getBotDimension(bot) {
  try {
    if (bot && bot.game && bot.game.dimension) {
      const d = String(bot.game.dimension);
      if (d.includes('nether')) return 'nether';
      if (d.includes('end'))    return 'the_end';
      return 'overworld';
    }
  } catch (_) {}
  return 'overworld';
}

// ── Summary snapshot for dashboard / REST ────────────────────────────────────

function getStatus() {
  const exploration = getExplorationStats();
  const topFinds    = getRecentFinds(10);
  const topHotspots = {};
  for (const fam of ['diamond', 'iron', 'gold', 'ancient_debris']) {
    const h = predictHotspots(fam, 1);
    if (h.length) topHotspots[fam] = h[0];
  }
  return {
    exploration,
    recentFinds: topFinds,
    topHotspots,
    playerCount: _players.size,
    resourceFindCount: _finds.length
  };
}

// ── MongoDB persistence flush ─────────────────────────────────────────────────

async function _flushChunks() {
  if (!mongo.isReady()) return;
  const dirty = Array.from(_chunks.values()).filter(c => c.dirty);
  for (const c of dirty) {
    await models.upsertExploredChunk(c).catch(() => {});
    c.dirty = false;
  }
}

async function _flushPlayers() {
  if (!mongo.isReady()) return;
  const dirty = Array.from(_players.values()).filter(p => p.dirty);
  for (const p of dirty) {
    await models.upsertPlayerBehavior(p).catch(() => {});
    p.dirty = false;
  }
}

setInterval(async () => {
  await _flushChunks().catch(() => {});
  await _flushPlayers().catch(() => {});
}, FLUSH_INTERVAL_MS);

// ── Bootstrap: load existing data from DB ─────────────────────────────────────

async function bootstrap() {
  if (!mongo.isReady()) return;
  try {
    const chunks = await models.listExploredChunks(5000);
    for (const c of chunks) {
      const key = _chunkKey(c.chunkX, c.chunkZ, c.dimension);
      if (!_chunks.has(key)) {
        _chunks.set(key, { ...c, dirty: false });
      }
    }
    const finds = await models.listResourceFinds(2000);
    for (const f of finds) {
      if (_finds.length < MAX_FINDS_MEM) _finds.push(f);
    }
    const players = await models.listPlayerBehaviors();
    for (const p of players) {
      if (!_players.has(p.username)) {
        _players.set(p.username, { ...p, dirty: false });
      }
    }
  } catch (_) {}
}

// Run bootstrap once DB is ready (poll for up to 30 s)
(function _waitAndBootstrap(attempts) {
  if (mongo.isReady()) { bootstrap(); return; }
  if (attempts <= 0) return;
  setTimeout(() => _waitAndBootstrap(attempts - 1), 2000);
})(15);

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Terrain
  recordChunkExplored,
  getExplorationStats,
  // Resources
  recordResourceFind,
  onScannerFind,
  predictHotspots,
  getAllHotspots,
  getRecentFinds,
  // Players
  recordPlayerSighting,
  recordPlayerChatSignal,
  getPlayerProfiles,
  getPlayerProfile,
  // Oracle attachment
  attach,
  // Status
  getStatus,
  // Metadata
  ORE_FAMILIES,
};
