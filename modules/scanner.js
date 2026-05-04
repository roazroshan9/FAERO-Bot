/**
 * FAERO — Area Scanner (modules/scanner.js)
 *
 * Performs periodic, async, yield-friendly 360° block scans within render
 * distance and maintains an internal map of discovered valuable blocks.
 *
 * Performance design:
 *  - Uses bot.findBlock() — Mineflayer's native BFS, terminates on first hit.
 *  - Yields to the event loop via setImmediate every YIELD_EVERY block types
 *    so the Minecraft client/pathfinder stays responsive.
 *  - Scans are de-bounced (only one scan runs at a time).
 *  - Results are cached between scans so consumers always have a fast answer.
 */

'use strict';

// Scan radius (blocks). Kept at 24 to match pathfinding.nearestBlock cap.
const SCAN_RANGE = 24;

// Time between background scans (ms). 8 s keeps CPU idle between checks.
const SCAN_INTERVAL = 8000;

// How many block-types to scan before yielding to the event loop.
const YIELD_EVERY = 4;

// ─── Valuable blocks FAERO tracks ─────────────────────────────────────────────

const SCAN_TARGETS = [
  // Overworld ores
  'coal_ore',            'deepslate_coal_ore',
  'iron_ore',            'deepslate_iron_ore',
  'copper_ore',          'deepslate_copper_ore',
  'gold_ore',            'deepslate_gold_ore',
  'redstone_ore',        'deepslate_redstone_ore',
  'lapis_ore',           'deepslate_lapis_ore',
  'diamond_ore',         'deepslate_diamond_ore',
  'emerald_ore',         'deepslate_emerald_ore',
  // Nether
  'ancient_debris',      'nether_gold_ore',      'quartz_ore',
  // Containers
  'chest',               'barrel',               'trapped_chest',
  // Special
  'spawner'
];

// ─── AreaScanner ──────────────────────────────────────────────────────────────

class AreaScanner {
  constructor() {
    /** @type {Map<string, {x:number,y:number,z:number}>} blockName → closest position */
    this._map       = new Map();
    this._timer     = null;
    this._scanning  = false;
    this._active    = false;
    this._scanCount = 0;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Start periodic background scanning. Safe to call multiple times. */
  start(bot) {
    if (this._active) return;
    this._active = true;
    // Run first scan immediately, then on interval
    this._scheduleNext(bot, 100);
  }

  /** Stop background scanning (does not clear the cached map). */
  stop() {
    this._active = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  isActive() { return this._active; }

  // ── On-demand scan ────────────────────────────────────────────────────────

  /**
   * Force an immediate full scan and await its completion.
   * Safe to call while background scanning is also running —
   * the scan guard (`_scanning`) prevents overlap.
   * Returns the number of distinct block types found.
   */
  async scanNow(bot) {
    await this._runScan(bot);
    return this._map.size;
  }

  // ── Scheduling ────────────────────────────────────────────────────────────

  _scheduleNext(bot, delayMs) {
    if (!this._active) return;
    const delay = delayMs !== undefined ? delayMs : SCAN_INTERVAL;
    this._timer = setTimeout(async () => {
      if (!this._active) return;
      await this._runScan(bot).catch(() => {});
      this._scheduleNext(bot);
    }, delay);
  }

  // ── Core scan loop ────────────────────────────────────────────────────────

  async _runScan(bot) {
    if (this._scanning) return;          // Don't pile up scans
    if (!bot || !bot.entity) return;
    this._scanning = true;

    try {
      let i = 0;
      for (const blockName of SCAN_TARGETS) {
        const blockType = bot.registry && bot.registry.blocksByName[blockName];
        if (!blockType) { i++; continue; }

        // findBlock is Mineflayer's native BFS — stops on first hit
        const found = bot.findBlock({
          matching: blockType.id,
          maxDistance: SCAN_RANGE,
          count: 1
        });

        if (found) {
          const isNew = !this._map.has(blockName);
          this._map.set(blockName, {
            x: found.position.x,
            y: found.position.y,
            z: found.position.z
          });
          // ── Hive Mind: share new resource discoveries with the fleet ────────
          if (isNew) {
            try {
              const hiveMind = require('../core/hiveMind');
              hiveMind.reportResource('scanner', {
                type: blockName,
                x: found.position.x,
                y: found.position.y,
                z: found.position.z
              });
            } catch (_) {}
          }
        } else {
          // Remove stale entry — block is no longer in range
          this._map.delete(blockName);
        }

        i++;
        // Yield every YIELD_EVERY iterations so event loop stays clear
        if (i % YIELD_EVERY === 0) {
          await new Promise(r => setImmediate(r));
        }
      }

      this._scanCount++;
    } finally {
      this._scanning = false;
    }
  }

  // ── Query API ─────────────────────────────────────────────────────────────

  /**
   * Returns true if `blockName` (or any deepslate/variant thereof) is in the map.
   * e.g. hasBlock('iron') matches 'iron_ore' and 'deepslate_iron_ore'.
   */
  hasBlock(blockName) {
    if (this._map.has(blockName)) return true;
    for (const key of this._map.keys()) {
      if (key.includes(blockName)) return true;
    }
    return false;
  }

  /**
   * Returns the cached position of the closest matching block (exact name or
   * a variant that contains `blockName`).
   * Returns null if not found in the map.
   */
  getClosest(bot, blockName) {
    let best     = null;
    let bestDist = Infinity;

    for (const [key, pos] of this._map.entries()) {
      if (key !== blockName && !key.includes(blockName)) continue;
      const d = bot.entity.position.distanceTo(pos);
      if (d < bestDist) {
        bestDist = d;
        best = { ...pos, blockName: key, dist: Math.round(d) };
      }
    }
    return best;
  }

  /**
   * Returns all block types currently in the map, with their positions.
   * Useful for building an area report.
   */
  getAll() {
    const result = [];
    for (const [name, pos] of this._map.entries()) {
      result.push({ name, pos });
    }
    return result;
  }

  /**
   * Compact summary string of what's in the map.
   * e.g. "iron_ore, diamond_ore, chest"
   */
  getSummary() {
    return Array.from(this._map.keys()).join(', ') || 'nothing found yet';
  }

  getScanCount() { return this._scanCount; }
  getMap()       { return this._map; }
}

module.exports = { AreaScanner, SCAN_TARGETS, SCAN_RANGE, SCAN_INTERVAL };
