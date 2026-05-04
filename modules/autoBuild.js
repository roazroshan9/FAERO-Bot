'use strict';

/**
 * FAERO — Auto Build Module (modules/autoBuild.js)
 *
 * Executes block-by-block builds from schematic data with full pathfinding,
 * inventory management, and chest-pull support.
 *
 * ── Schematic JSON format ─────────────────────────────────────────────────────
 *
 *  Relative (offsets from bot's current position — default):
 *  {
 *    "name": "my_build",
 *    "relative": true,
 *    "blocks": [
 *      { "dx": 0, "dy": 0, "dz": 0, "type": "oak_planks" },
 *      { "dx": 1, "dy": 0, "dz": 0, "type": "oak_planks" }
 *    ]
 *  }
 *
 *  Absolute (world coordinates):
 *  {
 *    "name": "my_build",
 *    "relative": false,
 *    "blocks": [
 *      { "x": 100, "y": 64, "z": 200, "type": "stone" }
 *    ]
 *  }
 *
 * ── Built-in schematics ───────────────────────────────────────────────────────
 *   platform_5x5  — 5×5 flat platform at feet level
 *   tower_3x3     — 3×3 solid tower, 5 blocks tall
 *   house_small   — 7×7 house outline, 4 walls + doorway
 *   staircase_8   — 8-step ascending staircase (east direction)
 *
 * ── Trigger methods ───────────────────────────────────────────────────────────
 *
 *  In-game chat (requires ADMIN tier):
 *    !build schematic platform_5x5
 *    !build schematic house_small
 *    !build status
 *    !build stop
 *    !build list
 *
 *  Web dashboard (POST /bot-api/build/run):
 *    { "name": "tower_3x3" }                     ← built-in by name
 *    { "schematic": { ...json object... } }       ← custom schematic object
 *    { "schematic": "{\"name\":...}" }            ← custom schematic JSON string
 *
 *  Other dashboard endpoints:
 *    GET  /bot-api/build/status
 *    POST /bot-api/build/cancel
 *    GET  /bot-api/build/schematics
 */

const Vec3          = require('vec3').Vec3;
const { goals }     = require('mineflayer-pathfinder');
const pathfinding   = require('./pathfinding');
const antiDetection = require('./antiDetection');

// ── Built-in schematic generators ────────────────────────────────────────────

function _makePlatform5x5() {
  const blocks = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      blocks.push({ dx, dy: 0, dz, type: 'oak_planks' });
    }
  }
  return { name: 'platform_5x5', relative: true, blocks };
}

function _makeTower3x3() {
  const blocks = [];
  for (let dy = 1; dy <= 5; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        blocks.push({ dx, dy, dz, type: 'stone' });
      }
    }
  }
  return { name: 'tower_3x3', relative: true, blocks };
}

function _makeHouseSmall() {
  const blocks = [];
  const size = 3; // half-width — total footprint is 7×7
  for (let dy = 0; dy <= 3; dy++) {
    for (let dx = -size; dx <= size; dx++) {
      for (let dz = -size; dz <= size; dz++) {
        if (Math.abs(dx) !== size && Math.abs(dz) !== size) continue; // interior = skip
        // 2-block doorway on south wall (dz === +size, dx in [-1,0], dy 0-1)
        if (dz === size && dx >= -1 && dx <= 0 && dy <= 1) continue;
        blocks.push({ dx, dy, dz, type: 'cobblestone' });
      }
    }
  }
  return { name: 'house_small', relative: true, blocks };
}

function _makeStaircase8() {
  const blocks = [];
  for (let i = 0; i < 8; i++) {
    // Fill each column so the staircase is solid underneath
    for (let fy = 0; fy <= i; fy++) {
      blocks.push({ dx: i, dy: fy, dz: 0, type: 'stone' });
    }
  }
  return { name: 'staircase_8', relative: true, blocks };
}

const BUILTINS = {
  platform_5x5: _makePlatform5x5,
  tower_3x3:    _makeTower3x3,
  house_small:  _makeHouseSmall,
  staircase_8:  _makeStaircase8
};

// ── Schematic parser ──────────────────────────────────────────────────────────

/**
 * Resolves a schematic input into a sorted list of absolute world positions.
 *
 * @param {string|object} input  — built-in name, JSON string, or schematic object
 * @param {{ x, y, z }}   origin — bot's current position (for relative schematics)
 * @returns {{ blocks: Array<{x,y,z,type}>, name: string }}
 */
function parseSchematic(input, origin) {
  let schema;

  if (typeof input === 'string' && BUILTINS[input]) {
    schema = BUILTINS[input]();
  } else if (typeof input === 'string') {
    try {
      schema = JSON.parse(input);
    } catch (err) {
      throw new Error('Invalid schematic JSON: ' + err.message);
    }
  } else if (input && typeof input === 'object') {
    schema = input;
  } else {
    throw new Error('Schematic must be a built-in name, JSON string, or object');
  }

  if (!Array.isArray(schema.blocks) || schema.blocks.length === 0) {
    throw new Error('Schematic must have a non-empty "blocks" array');
  }

  const name     = schema.name || 'unnamed';
  const relative = schema.relative !== false; // default: true
  const ox = origin && Number.isFinite(origin.x) ? Math.floor(origin.x) : 0;
  const oy = origin && Number.isFinite(origin.y) ? Math.floor(origin.y) : 0;
  const oz = origin && Number.isFinite(origin.z) ? Math.floor(origin.z) : 0;

  const rawBlocks = schema.blocks.map((b, i) => {
    const type = String(b.type || '').trim();
    if (!type) throw new Error('Block at index ' + i + ' is missing "type"');

    let x, y, z;
    if (relative) {
      x = ox + (Number(b.dx) || 0);
      y = oy + (Number(b.dy) || 0);
      z = oz + (Number(b.dz) || 0);
    } else {
      x = Number(b.x) || 0;
      y = Number(b.y) || 0;
      z = Number(b.z) || 0;
    }

    return { x, y, z, type };
  });

  // Deduplicate — later entries in the array override earlier ones at same coords
  const seen = new Map();
  for (const b of rawBlocks) {
    seen.set(b.x + ',' + b.y + ',' + b.z, b);
  }

  // Sort bottom-up (lowest Y first), then outward from origin so the bot
  // always has a solid surface to place against
  const sorted = Array.from(seen.values()).sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    const da = Math.abs(a.x - ox) + Math.abs(a.z - oz);
    const db = Math.abs(b.x - ox) + Math.abs(b.z - oz);
    return da - db;
  });

  return { blocks: sorted, name };
}

// ── Inventory management ──────────────────────────────────────────────────────

/**
 * Computes what blocks are required and what is already in the bot's inventory.
 *
 * @returns {{ ready, have, need, missing }}
 */
function checkInventory(bot, blocks) {
  const need = {};
  for (const b of blocks) {
    need[b.type] = (need[b.type] || 0) + 1;
  }

  const have = {};
  for (const item of bot.inventory.items()) {
    have[item.name] = (have[item.name] || 0) + item.count;
  }

  const missing = {};
  for (const [type, count] of Object.entries(need)) {
    const available = have[type] || 0;
    if (available < count) missing[type] = count - available;
  }

  return { ready: Object.keys(missing).length === 0, have, need, missing };
}

/**
 * Navigates to a nearby chest (or barrel) and withdraws missing items.
 *
 * @returns {{ pulled: {type:count}, stillMissing: {type:count} }}
 */
async function pullFromChest(bot, missing, onLog) {
  const log = onLog || function () {};

  const reg = bot.registry;
  if (!reg) return { pulled: {}, stillMissing: missing };

  const matchIds = ['chest', 'barrel', 'trapped_chest']
    .map((n) => reg.blocksByName[n])
    .filter(Boolean)
    .map((b) => b.id);

  if (!matchIds.length) return { pulled: {}, stillMissing: missing };

  const chestBlock = bot.findBlock({ matching: matchIds, maxDistance: 16 });
  if (!chestBlock) {
    log('[autoBuild] No chest/barrel found within 16 blocks — skipping pull');
    return { pulled: {}, stillMissing: missing };
  }

  log('[autoBuild] Chest at ' + chestBlock.position.x + ',' + chestBlock.position.y + ',' + chestBlock.position.z + ' — navigating…');

  try {
    await pathfinding.goToCoords(
      bot, chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2
    );
  } catch (_) {
    // Might already be close enough — attempt to open anyway
  }

  let window;
  try {
    window = await bot.openChest(chestBlock);
  } catch (err) {
    log('[autoBuild] Could not open chest: ' + (err && err.message ? err.message : 'unknown'));
    return { pulled: {}, stillMissing: missing };
  }

  const pulled      = {};
  const stillMissing = {};

  for (const [type, needed] of Object.entries(missing)) {
    const itemDef = reg.itemsByName[type] || reg.blocksByName[type];
    if (!itemDef) { stillMissing[type] = needed; continue; }

    const slot = window.items().find((i) => i.type === itemDef.id);
    if (!slot) { stillMissing[type] = needed; continue; }

    const canTake = Math.min(needed, slot.count);
    try {
      await window.withdraw(slot.type, null, canTake);
      pulled[type] = canTake;
      const leftover = needed - canTake;
      if (leftover > 0) stillMissing[type] = leftover;
      log('[autoBuild] Pulled ' + canTake + ' × ' + type + ' from chest');
    } catch (_) {
      stillMissing[type] = needed;
    }
  }

  try { window.close(); } catch (_) {}

  return { pulled, stillMissing };
}

// ── Block placement ───────────────────────────────────────────────────────────

// Each face descriptor: neighbor offset that must be solid + the face vector to click
const PLACE_FACES = [
  { dx:  0, dy: -1, dz:  0, face: new Vec3( 0,  1,  0) }, // block below  → top face    ✓ first priority
  { dx: -1, dy:  0, dz:  0, face: new Vec3( 1,  0,  0) }, // block west   → east face
  { dx:  1, dy:  0, dz:  0, face: new Vec3(-1,  0,  0) }, // block east   → west face
  { dx:  0, dy:  0, dz: -1, face: new Vec3( 0,  0,  1) }, // block north  → south face
  { dx:  0, dy:  0, dz:  1, face: new Vec3( 0,  0, -1) }, // block south  → north face
  { dx:  0, dy:  1, dz:  0, face: new Vec3( 0, -1,  0) }  // block above  → bottom face
];

// Blocks that can't be used as a placement reference (non-solid)
const NON_SOLID = new Set([
  'air', 'cave_air', 'void_air',
  'water', 'flowing_water', 'lava', 'flowing_lava',
  'grass', 'tall_grass', 'fern', 'large_fern',
  'seagrass', 'kelp', 'kelp_plant'
]);

/**
 * Navigate within reach of (x, y, z) and place a block of typeName there.
 *
 * @returns {'placed' | 'skipped' | 'failed'}
 */
async function placeOneBlock(bot, x, y, z, typeName, onLog) {
  const log = onLog || function () {};

  // Already occupied — nothing to do
  const existing = bot.blockAt(new Vec3(x, y, z));
  if (existing && !NON_SOLID.has(existing.name)) return 'skipped';

  // Resolve item in registry
  const reg     = bot.registry;
  const itemDef = reg && (reg.itemsByName[typeName] || reg.blocksByName[typeName]);
  if (!itemDef) {
    log('[autoBuild] Unknown item type "' + typeName + '" — skipping block');
    return 'failed';
  }

  const stack = bot.inventory.items().find((i) => i.type === itemDef.id);
  if (!stack) {
    log('[autoBuild] Missing in inventory: ' + typeName + ' — skipping');
    return 'failed';
  }

  // Navigate to within 4 blocks of the target position
  try {
    pathfinding.setupMovements(bot);
    const goal = new goals.GoalNear(x, y, z, 4);
    let navTimer;
    const navTimeout = new Promise((_, reject) => {
      navTimer = setTimeout(() => {
        try { bot.pathfinder.setGoal(null); bot.pathfinder.stop(); } catch (_) {}
        reject(new Error('nav-timeout'));
      }, 15000);
    });
    await Promise.race([bot.pathfinder.goto(goal), navTimeout]);
    clearTimeout(navTimer);
  } catch (err) {
    // If we timed out but we're already close enough, try anyway
    const pos = bot.entity && bot.entity.position;
    if (!pos) return 'failed';
    const dist = pos.distanceTo(new Vec3(x, y, z));
    if (dist > 5.5) {
      log('[autoBuild] Cannot reach ' + x + ',' + y + ',' + z +
          ' (' + Math.round(dist) + ' blocks away)');
      return 'failed';
    }
  }

  // Equip the block item
  try { await bot.equip(stack, 'hand'); } catch (_) {}

  // Re-check: another tick might have placed something here already
  const recheck = bot.blockAt(new Vec3(x, y, z));
  if (recheck && !NON_SOLID.has(recheck.name)) return 'skipped';

  // Try each adjacent face in priority order
  for (const { dx, dy, dz, face } of PLACE_FACES) {
    const nPos     = new Vec3(x + dx, y + dy, z + dz);
    const refBlock = bot.blockAt(nPos);

    if (!refBlock || NON_SOLID.has(refBlock.name)) continue;

    // Look at the clickable face of the reference block (center of that face)
    const lookAt = new Vec3(
      nPos.x + 0.5 + face.x * 0.5,
      nPos.y + 0.5 + face.y * 0.5,
      nPos.z + 0.5 + face.z * 0.5
    );

    try {
      await bot.lookAt(lookAt, true);
      await antiDetection.jitter(50, 160); // slight pre-placement pause
      await bot.placeBlock(refBlock, face);
      return 'placed';
    } catch (_) {
      continue; // try next face
    }
  }

  log('[autoBuild] No valid face found for ' + typeName + ' at ' + x + ',' + y + ',' + z);
  return 'failed';
}

// ── Session state ─────────────────────────────────────────────────────────────

let _session = null;

/** Returns the current build progress (or { active: false } when idle). */
function getBuildStatus() {
  if (!_session) return { active: false };
  return {
    active:    true,
    name:      _session.name,
    placed:    _session.placed,
    skipped:   _session.skipped,
    failed:    _session.failed,
    total:     _session.total,
    remaining: _session.total - _session.placed - _session.skipped - _session.failed,
    cancelled: _session.cancelled
  };
}

/** Requests cancellation of the running build. Returns true if one was active. */
function cancelBuild() {
  if (_session) { _session.cancelled = true; return true; }
  return false;
}

// ── Main build executor ───────────────────────────────────────────────────────

/**
 * Execute a build from a schematic.
 *
 * @param {object}        bot
 * @param {string|object} schematicInput  — built-in name, JSON string, or object
 * @param {object}        [opts]
 * @param {function}      [opts.onLog]       — (msg: string) => void
 * @param {function}      [opts.onProgress]  — ({ placed, total, name, result }) => void
 * @param {object}        [opts.state]       — StateManager instance
 * @param {boolean}       [opts.pullChest]   — try chest pull when missing items (default true)
 * @returns {Promise<{ placed, skipped, failed, missing, total, cancelled }>}
 */
async function executeBuild(bot, schematicInput, opts) {
  if (!bot || !bot.entity) throw new Error('Bot is not spawned');

  const onLog      = (opts && opts.onLog)      || function () {};
  const onProgress = (opts && opts.onProgress) || function () {};
  const state      = opts && opts.state;
  const doPull     = !opts || opts.pullChest !== false;

  // Cancel any previously running build
  if (_session) _session.cancelled = true;

  const origin            = bot.entity.position;
  const { blocks, name }  = parseSchematic(schematicInput, origin);

  onLog('[autoBuild] Loaded "' + name + '" — ' + blocks.length + ' blocks');

  // ── Inventory pre-flight ────────────────────────────────────────────────────
  const inv = checkInventory(bot, blocks);

  if (!inv.ready) {
    const missingStr = Object.entries(inv.missing)
      .map(([t, c]) => c + '×' + t).join(', ');
    onLog('[autoBuild] Missing items: ' + missingStr);

    if (doPull) {
      onLog('[autoBuild] Checking nearby chests…');
      const { stillMissing } = await pullFromChest(bot, inv.missing, onLog);

      if (Object.keys(stillMissing).length > 0) {
        const stillStr = Object.entries(stillMissing)
          .map(([t, c]) => c + '×' + t).join(', ');
        onLog('[autoBuild] Still missing after chest: ' + stillStr +
              ' — will skip those blocks');
      }
    }
  } else {
    onLog('[autoBuild] Inventory check passed — all materials present');
  }

  // ── Create session ──────────────────────────────────────────────────────────
  _session = { name, total: blocks.length, placed: 0, skipped: 0, failed: 0, cancelled: false };

  if (state) {
    try { state.setState('building', 'schematic:' + name); } catch (_) {}
  }

  onLog('[autoBuild] Starting build "' + name + '" (' + blocks.length + ' blocks)…');

  // ── Block-by-block placement loop ───────────────────────────────────────────
  for (const block of blocks) {
    if (_session.cancelled) break;

    const result = await placeOneBlock(bot, block.x, block.y, block.z, block.type, onLog);

    if (result === 'placed')  _session.placed++;
    if (result === 'skipped') _session.skipped++;
    if (result === 'failed')  _session.failed++;

    onProgress({ name, placed: _session.placed, total: _session.total, result, current: block });

    // Human-like jitter after each successful placement
    if (result === 'placed') await antiDetection.jitter(180, 520);
  }

  const summary = {
    placed:    _session.placed,
    skipped:   _session.skipped,
    failed:    _session.failed,
    missing:   inv.missing,
    total:     _session.total,
    cancelled: _session.cancelled
  };

  onLog('[autoBuild] "' + name + '" complete — placed:' + summary.placed +
        ' skipped:' + summary.skipped + ' failed:' + summary.failed +
        (summary.cancelled ? ' (CANCELLED)' : ''));

  if (state) {
    try { state.reset('build_complete'); } catch (_) {}
  }

  _session = null;
  return summary;
}

// ── Exports ───────────────────────────────────────────────────────────────────

function listSchematics() { return Object.keys(BUILTINS); }

module.exports = {
  parseSchematic,
  checkInventory,
  pullFromChest,
  placeOneBlock,
  executeBuild,
  cancelBuild,
  getBuildStatus,
  listSchematics,
  BUILTINS
};
