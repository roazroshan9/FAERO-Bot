'use strict';

/**
 * FAERO — Farming Module (modules/farming.js)
 *
 * Provides auto-replant wheat harvesting and a demand-based / scheduled
 * FarmScheduler that triggers a full farm cycle every FARM_CYCLE_MS.
 *
 * Key improvements over the legacy survival.farmWheat():
 *   • Detects mature wheat (age === 7) via block properties
 *   • After harvesting, checks for seeds and replants on the same farmland
 *   • FarmScheduler runs on a configurable timer (default 10 min) and can
 *     be started/stopped independently of the bot brain
 *
 * Public API:
 *   farmWheatWithReplant(bot, opts)   → { harvested, replanted }
 *   class FarmScheduler               → start(bot) / stop() / triggerNow()
 *   FARM_CYCLE_MS                     → default interval constant
 */

const { goals } = require('mineflayer-pathfinder');
const Vec3      = require('vec3').Vec3;
const pathfinding = require('./pathfinding');
const inventory   = require('./inventory');

const WHEAT_NAME      = 'wheat';
const FARMLAND_NAME   = 'farmland';
const SEED_NAMES      = ['wheat_seeds'];
const MATURE_AGE      = 7;
const SCAN_RADIUS     = 48;
const FARM_CYCLE_MS   = Number(process.env.FARM_CYCLE_MS) || 10 * 60 * 1000; // 10 min
const MAX_PER_CYCLE   = 64;  // wheat blocks per cycle cap

// ── Block helpers ──────────────────────────────────────────────────────────────

/**
 * Find the nearest mature (age === 7) wheat block within SCAN_RADIUS.
 * Falls back to metadata check for servers that don't expose getProperties().
 */
function findMatureWheat(bot) {
  const def = bot.registry && bot.registry.blocksByName[WHEAT_NAME];
  if (!def) return null;

  return bot.findBlock({
    matching: (block) => {
      if (block.type !== def.id) return false;
      // mineflayer 4.x: getProperties() returns { age: '7' } (string)
      try {
        const props = block.getProperties && block.getProperties();
        if (props) return String(props.age) === String(MATURE_AGE);
      } catch (_) {}
      // Fallback: metadata (older server versions)
      return block.metadata === MATURE_AGE;
    },
    maxDistance: SCAN_RADIUS
  });
}

/**
 * Check whether the block directly below (x, y-1, z) is farmland.
 */
function isFarmlandBelow(bot, x, y, z) {
  try {
    const below = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y) - 1, Math.floor(z)));
    return Boolean(below && below.name === FARMLAND_NAME);
  } catch (_) { return false; }
}

function hasSeeds(bot) {
  return SEED_NAMES.some(n => inventory.countItem(bot, [n]) > 0);
}

async function equipSeeds(bot) {
  for (const name of SEED_NAMES) {
    const item = inventory.findItem(bot, [name]);
    if (item) {
      try { await bot.equip(item, 'hand'); return true; } catch (_) {}
    }
  }
  return false;
}

// ── Navigate to a block ───────────────────────────────────────────────────────

async function approachBlock(bot, block) {
  pathfinding.setupMovements(bot);
  try {
    await Promise.race([
      bot.pathfinder.goto(
        new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)
      ),
      sleep(8000)
    ]);
  } catch (_) {}
}

// ── Harvest one wheat block ───────────────────────────────────────────────────

async function harvestOne(bot, block) {
  await approachBlock(bot, block);
  try {
    await bot.dig(block);
    return true;
  } catch (_) {
    return false;
  }
}

// ── Replant at a harvested position ──────────────────────────────────────────

async function replantAt(bot, x, y, z) {
  if (!hasSeeds(bot))                      return false;
  if (!isFarmlandBelow(bot, x, y, z))      return false;

  const equipped = await equipSeeds(bot);
  if (!equipped) return false;

  try {
    // The face block is the farmland tile below
    const farmland = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y) - 1, Math.floor(z)));
    if (!farmland) return false;
    await bot.placeBlock(farmland, new Vec3(0, 1, 0));
    return true;
  } catch (_) {
    return false;
  }
}

// ── Public: farmWheatWithReplant ───────────────────────────────────────────────

/**
 * Scan for mature wheat, harvest each block, and immediately replant if seeds
 * are available.  Runs until no more mature wheat is found or maxCycles hit.
 *
 * @param {object} bot
 * @param {{ maxCycles?:number, onProgress?:Function }} [opts]
 * @returns {Promise<{ harvested:number, replanted:number }>}
 */
async function farmWheatWithReplant(bot, opts) {
  const maxCycles  = (opts && opts.maxCycles)  || MAX_PER_CYCLE;
  const onProgress = (opts && opts.onProgress) || null;

  let harvested = 0;
  let replanted = 0;

  for (let i = 0; i < maxCycles; i++) {
    if (!bot || !bot.entity) break;

    const block = findMatureWheat(bot);
    if (!block) break;

    const { x, y, z } = block.position;
    const ok = await harvestOne(bot, block);
    if (!ok) break;

    harvested++;
    if (onProgress) onProgress(harvested, replanted);

    await sleep(180);

    const didReplant = await replantAt(bot, x, y, z);
    if (didReplant) replanted++;

    await sleep(120);
  }

  return { harvested, replanted };
}

// ── FarmScheduler ──────────────────────────────────────────────────────────────

/**
 * Runs farmWheatWithReplant() on a configurable timer.
 *
 * Usage:
 *   const sched = new FarmScheduler({ cycleMs: 600000, onLog: manager.log.bind(manager) });
 *   sched.start(bot);       // start periodic cycles
 *   sched.triggerNow();     // demand-based trigger (resets timer)
 *   sched.stop();           // stop all cycles
 */
class FarmScheduler {
  constructor(opts) {
    this._cycleMs  = (opts && opts.cycleMs)  || FARM_CYCLE_MS;
    this._onLog    = (opts && opts.onLog)    || (() => {});
    this._onResult = (opts && opts.onResult) || (() => {});
    this._timer    = null;
    this._active   = false;
    this._bot      = null;
    this._busy     = false;
  }

  start(bot) {
    if (this._active) return;
    this._bot    = bot;
    this._active = true;
    this._onLog('[farming] Scheduler started — cycle every ' +
      Math.round(this._cycleMs / 60000) + ' min');
    this._schedule(this._cycleMs); // first cycle after full delay
  }

  stop() {
    this._active = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._onLog('[farming] Scheduler stopped');
  }

  /** Trigger an immediate cycle (e.g. on player demand), then reset the timer. */
  triggerNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._runCycle();
  }

  updateBot(bot) { this._bot = bot; }

  isActive() { return this._active; }

  _schedule(delayMs) {
    if (!this._active) return;
    this._timer = setTimeout(() => this._runCycle(), delayMs != null ? delayMs : this._cycleMs);
  }

  async _runCycle() {
    if (!this._active || this._busy) { this._schedule(); return; }

    const bot = this._bot;
    if (!bot || !bot.entity) { this._schedule(); return; }

    this._busy = true;
    this._onLog('[farming] Auto-farm cycle starting');

    try {
      const result = await farmWheatWithReplant(bot, {
        onProgress: (h, r) => {
          if (h % 8 === 0) this._onLog('[farming] …' + h + ' harvested, ' + r + ' replanted');
        }
      });
      this._onLog('[farming] Cycle complete — harvested: ' + result.harvested +
        ', replanted: ' + result.replanted);
      this._onResult(result);
    } catch (err) {
      this._onLog('[farming] Cycle error: ' + (err && err.message ? err.message : String(err)));
    } finally {
      this._busy = false;
    }

    this._schedule();
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  farmWheatWithReplant,
  FarmScheduler,
  FARM_CYCLE_MS,
  SEED_NAMES,
  WHEAT_NAME
};
