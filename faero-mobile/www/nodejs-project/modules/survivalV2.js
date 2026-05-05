'use strict';

/**
 * FAERO — Autonomous Survival v2 (modules/survivalV2.js)
 *
 * Full self-directed survival loop for ANY Mineflayer bot (leader or minion).
 * Unlike the leader-only Brain/DecisionEngine, this attaches directly to a
 * bot instance and runs an independent priority-state machine every TICK_MS.
 *
 * Priority chain (evaluated top-down each tick):
 *   1. CRITICAL  — HP ≤ 4 OR hunger ≤ 4         → emergency eat + flee all mobs
 *   2. FLEE      — HP ≤ 8 AND hostile within 6bl  → tactical retreat 14 blocks + eat
 *   3. EAT       — hunger < 14                   → eat inventory → collect drops → request hive → hunt
 *   4. HEAL      — HP < 12                       → stop, eat, wait for HP regen
 *   5. ARMOR     — missing armor + has items      → equip best available
 *   6. TOOL      — no pickaxe + has materials     → craft replacement (30s cooldown)
 *   7. SHELTER   — night (t ≥ 11500) + outdoors  → find natural shelter → or build dirt hut
 *   8. IDLE      — all clear                     → no-op (follow loop handles movement)
 *
 * Hive Mind integration:
 *   - When hungry and inventory is empty, broadcasts food_request to the hive.
 *     The nearest bot with surplus food is chosen as donor; its position is the
 *     meet-up point.  The requesting bot navigates there and picks up the food.
 *   - Listens for hive broadcasts of type 'food_request' so a donor bot can
 *     proactively drop food for the requester.
 *   - Avoids hive-registered danger zones when seeking shelter coordinates.
 *   - Reports survival state to the hive task ledger so the dashboard shows it.
 *
 * Usage (one instance per bot):
 *   const survivalV2 = require('./survivalV2');
 *   const loop = survivalV2.create();
 *   loop.attach(bot, { botId, role, onLog });   // starts the timer
 *   loop.detach();                               // stops, cleans up
 */

const survival    = require('./survival');
const combat      = require('./combat');
const pathfinding = require('./pathfinding');
const { goals }   = require('mineflayer-pathfinder');

// ── Constants ──────────────────────────────────────────────────────────────────

const TICK_MS            = 6000;   // main loop interval (ms)
const HUNGER_CRITICAL    = 4;      // starving — emergency eat
const HUNGER_EAT         = 14;     // begin eating
const HP_CRITICAL        = 4;      // HP — emergency flee + eat
const HP_FLEE            = 8;      // HP — flee if mob is close
const HP_HEAL            = 12;     // HP — stop and regenerate
const HP_REENGAGE        = 15;     // HP — resume normal activity after healing

const HOSTILE_FLEE_RANGE = 6;      // blocks — flee trigger range when HP low
const RETREAT_DIST       = 14;     // blocks — flee distance
const MAX_HEAL_WAIT_MS   = 15000;  // max ms to wait for HP regen per tick

// Night / shelter
const DUSK_TICKS         = 11500;  // Minecraft day ticks — start seeking shelter
const DAWN_TICKS         = 23500;  // "night ends" threshold (wraps around 24000)
const SHELTER_RADIUS     = 14;     // blocks — scan for existing shelter
const SHELTER_ROOF_DEPTH = 4;      // blocks overhead to count as "roofed"
const SHELTER_COOLDOWN   = 25000;  // ms — don't re-check shelter too often

// Food & tool
const MIN_FOOD_RESERVE   = 4;      // items — don't strip another bot below this
const TOOL_CRAFT_COOLDOWN = 30000; // ms — min time between craft attempts
const HUNT_COOLDOWN       = 20000; // ms — min time between hunt attempts
const FOOD_REQ_COOLDOWN   = 15000; // ms — min time between hive food requests

// ── Food priority (highest saturation first) ──────────────────────────────────

const FOOD_PRIORITY = [
  'golden_carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton',
  'cooked_chicken', 'cooked_salmon', 'cooked_cod', 'bread',
  'baked_potato', 'carrot', 'apple', 'potato', 'beef', 'porkchop',
  'chicken', 'mutton', 'melon_slice', 'sweet_berries', 'beetroot',
  'pumpkin_pie', 'cookie', 'dried_kelp', 'suspicious_stew'
];

// Items usable as emergency build material for a quick shelter roof
const BUILD_MATERIALS = [
  'dirt', 'cobblestone', 'oak_planks', 'spruce_planks', 'birch_planks',
  'stone', 'gravel', 'sand', 'netherrack', 'sandstone'
];

const HOSTILE_SET = new Set([
  'zombie', 'skeleton', 'spider', 'creeper', 'witch', 'enderman',
  'blaze', 'wither_skeleton', 'husk', 'stray', 'drowned', 'cave_spider',
  'guardian', 'elder_guardian', 'piglin_brute', 'vindicator', 'evoker',
  'ravager', 'pillager', 'phantom', 'zoglin', 'slime', 'magma_cube'
]);

// Armor slot name → ordered list of preferred item names
const ARMOR_CHOICES = {
  head:  ['netherite_helmet',     'diamond_helmet',     'iron_helmet',     'chainmail_helmet',     'golden_helmet',     'leather_helmet'],
  torso: ['netherite_chestplate', 'diamond_chestplate', 'iron_chestplate', 'chainmail_chestplate', 'golden_chestplate', 'leather_chestplate'],
  legs:  ['netherite_leggings',   'diamond_leggings',   'iron_leggings',   'chainmail_leggings',   'golden_leggings',   'leather_leggings'],
  feet:  ['netherite_boots',      'diamond_boots',      'iron_boots',      'chainmail_boots',      'golden_boots',      'leather_boots']
};

// ── SurvivalLoop class ────────────────────────────────────────────────────────

class SurvivalLoop {
  constructor() {
    this._bot    = null;
    this._botId  = null;
    this._role   = 'soldier';
    this._onLog  = null;
    this._timer  = null;
    this._running = false;
    this._busy    = false;      // guard: prevent overlapping ticks

    // State
    this._state    = 'idle';
    this._sheltered  = false;
    this._shelterPos = null;   // { x, y, z } of found / built shelter
    this._builtShelter = false;

    // Cooldown timestamps
    this._lastFoodRequest  = 0;
    this._lastHuntAttempt  = 0;
    this._lastToolCraft    = 0;
    this._lastShelterCheck = 0;

    // Hive food-share listener (stored so we can remove it on detach)
    this._hiveFoodListener = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Attach this loop to a mineflayer bot instance and start ticking.
   * Safe to call multiple times — detaches first if already running.
   *
   * @param {object} bot   Mineflayer bot instance (must already have pathfinder loaded)
   * @param {object} opts
   *   @param {string}   opts.botId  Hive Mind bot ID (e.g. 'soldier_3')
   *   @param {string}   opts.role   'leader' | 'soldier'
   *   @param {function} opts.onLog  (msg: string) => void
   */
  attach(bot, { botId = 'unknown', role = 'soldier', onLog = null } = {}) {
    this.detach();
    this._bot     = bot;
    this._botId   = botId;
    this._role    = role;
    this._onLog   = typeof onLog === 'function' ? onLog : () => {};
    this._running = true;
    this._timer   = setInterval(() => this._safeTick(), TICK_MS);
    this._attachHiveListener();
    this._log('[survivalV2:' + botId + '] Loop started (' + role + ')');
  }

  /** Stop the loop and release all references. */
  detach() {
    this._running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._detachHiveListener();
    this._bot    = null;
    this._botId  = null;
    this._busy   = false;
    this._state  = 'idle';
  }

  isAttached() { return this._running && this._bot != null; }
  getState()   { return this._state; }

  // ── Tick wrapper ─────────────────────────────────────────────────────────────

  async _safeTick() {
    if (!this._running || !this._bot || !this._bot.entity) return;
    if (this._busy) return;
    this._busy = true;
    try {
      await this._tick();
    } catch (err) {
      this._log('[survivalV2:' + this._botId + '] Tick error: ' + _msg(err));
    } finally {
      this._busy = false;
    }
  }

  // ── Priority state machine ────────────────────────────────────────────────────

  async _tick() {
    const bot    = this._bot;
    if (!bot || !bot.entity) return;

    const hp     = (typeof bot.health === 'number') ? bot.health : 20;
    const hunger = (typeof bot.food   === 'number') ? bot.food   : 20;

    // ── 1. CRITICAL ────────────────────────────────────────────────────────────
    if (hp <= HP_CRITICAL || hunger <= HUNGER_CRITICAL) {
      this._setState('critical');
      await this._handleCritical(bot, hp, hunger);
      return;
    }

    // ── 2. FLEE ────────────────────────────────────────────────────────────────
    if (hp <= HP_FLEE) {
      const mob = this._nearestHostile(bot, HOSTILE_FLEE_RANGE);
      if (mob) {
        this._setState('fleeing');
        await this._handleFlee(bot, mob);
        return;
      }
    }

    // ── 3. EAT ─────────────────────────────────────────────────────────────────
    if (hunger < HUNGER_EAT) {
      this._setState('eating');
      await this._handleHungry(bot, hunger);
      return;
    }

    // ── 4. HEAL ────────────────────────────────────────────────────────────────
    if (hp < HP_HEAL) {
      this._setState('healing');
      await this._handleHealing(bot, hp);
      return;
    }

    // ── 5. ARMOR ───────────────────────────────────────────────────────────────
    if (this._needsArmor(bot)) {
      this._setState('armoring');
      await this._handleArmor(bot);
    }

    // ── 6. TOOLS ───────────────────────────────────────────────────────────────
    if (!survival.hasAnyPickaxe(bot)) {
      const now = Date.now();
      if (now - this._lastToolCraft > TOOL_CRAFT_COOLDOWN) {
        this._setState('toolcraft');
        await this._handleToolCraft(bot);
      }
    }

    // ── 7. SHELTER ─────────────────────────────────────────────────────────────
    if (this._isNight(bot) && !this._sheltered) {
      const now = Date.now();
      if (now - this._lastShelterCheck > SHELTER_COOLDOWN) {
        this._lastShelterCheck = now;
        this._setState('sheltering');
        await this._handleShelter(bot);
        return;
      }
    } else if (!this._isNight(bot)) {
      // Reset shelter state at dawn
      if (this._sheltered || this._builtShelter) {
        this._sheltered     = false;
        this._shelterPos    = null;
        this._builtShelter  = false;
        this._log('[survivalV2:' + this._botId + '] Dawn — leaving shelter');
      }
    }

    this._setState('idle');
    this._reportHiveTask('idle');
  }

  // ── Priority handlers ────────────────────────────────────────────────────────

  async _handleCritical(bot, hp, hunger) {
    this._log('[survivalV2:' + this._botId + '] ⚠ CRITICAL — HP:' + Math.round(hp) + ' Hunger:' + hunger);
    this._reportHiveTask('critical');

    // Eat immediately if starving
    if (hunger <= HUNGER_CRITICAL) {
      await this._eatBestFood(bot, true);
    }

    // Flee all nearby mobs
    const mob = this._nearestHostile(bot, 20);
    if (mob && mob.position) {
      await this._fleeFrom(bot, mob.position, RETREAT_DIST);
    }

    // Eat again after fleeing
    if ((typeof bot.food === 'number' && bot.food < HUNGER_EAT) ||
        (typeof bot.health === 'number' && bot.health < HP_HEAL)) {
      await this._eatBestFood(bot, true);
    }
  }

  async _handleFlee(bot, mob) {
    this._log('[survivalV2:' + this._botId + '] ↩ Fleeing ' + (mob.name || 'mob') +
              ' — HP ' + Math.round(bot.health));
    this._reportHiveTask('fleeing');
    if (mob.position) await this._fleeFrom(bot, mob.position, RETREAT_DIST);
    if (typeof bot.food === 'number' && bot.food < HUNGER_EAT) {
      await this._eatBestFood(bot, false);
    }
  }

  async _handleHungry(bot, hunger) {
    this._reportHiveTask('eating');

    // Step 1: eat from own inventory
    const ate = await this._eatBestFood(bot, false);
    if (ate) return;

    // Step 2: collect nearby dropped food items
    const gotDrop = await this._collectNearbyFood(bot);
    if (gotDrop) {
      await this._eatBestFood(bot, false);
      return;
    }

    // Step 3: request food from hive (another bot with surplus)
    const now = Date.now();
    if (now - this._lastFoodRequest > FOOD_REQ_COOLDOWN) {
      this._lastFoodRequest = now;
      const meetPos = this._requestFoodFromHive(bot);
      if (meetPos) {
        this._log('[survivalV2:' + this._botId + '] Hive food meet-up at ' +
                  Math.round(meetPos.x) + ',' + Math.round(meetPos.y) + ',' + Math.round(meetPos.z));
        try {
          await pathfinding.goToCoords(bot, meetPos.x, meetPos.y, meetPos.z, 3);
          await _sleep(1500);
          await this._eatBestFood(bot, false);
        } catch (_) {}
        return;
      }
    }

    // Step 4: hunt nearby animals
    if (now - this._lastHuntAttempt > HUNT_COOLDOWN) {
      this._lastHuntAttempt = now;
      this._log('[survivalV2:' + this._botId + '] Hunger ' + hunger + ' — hunting');
      await this._hunt(bot);
    }
  }

  async _handleHealing(bot, hp) {
    this._log('[survivalV2:' + this._botId + '] ♥ Healing — HP ' + Math.round(hp) + '/20');
    this._reportHiveTask('healing');

    // Stop all movement
    _stopMovement(bot);

    // Eat to accelerate natural regen
    await this._eatBestFood(bot, false);

    // Wait up to MAX_HEAL_WAIT_MS, checking HP every second
    const deadline = Date.now() + MAX_HEAL_WAIT_MS;
    while (Date.now() < deadline) {
      if (!this._bot || !this._bot.entity) break;
      const currentHp = typeof this._bot.health === 'number' ? this._bot.health : 20;
      if (currentHp >= HP_REENGAGE) break;

      // Re-eat if hunger dropped while waiting
      if (typeof this._bot.food === 'number' && this._bot.food < HUNGER_EAT) {
        await this._eatBestFood(this._bot, false);
      }
      await _sleep(1000);
    }
  }

  async _handleArmor(bot) {
    this._reportHiveTask('equip_armor');
    try {
      if (bot.armorManager && bot.armorManager.equipAll) {
        await bot.armorManager.equipAll();
        this._log('[survivalV2:' + this._botId + '] Armor equipped via armorManager');
        return;
      }
      // Manual fallback
      for (const [bodyPart, names] of Object.entries(ARMOR_CHOICES)) {
        for (const name of names) {
          const item = bot.inventory.items().find(i => i.name === name);
          if (item) {
            try { await bot.equip(item, bodyPart); break; } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }

  async _handleToolCraft(bot) {
    this._lastToolCraft = Date.now();
    this._reportHiveTask('craft_tool');
    try {
      const result = await survival.ensurePickaxe(bot);
      if (result.ok) {
        this._log('[survivalV2:' + this._botId + '] Crafted ' + (result.tool || 'pickaxe'));
      } else {
        this._log('[survivalV2:' + this._botId + '] Tool craft failed: ' + result.reason);
      }
    } catch (_) {}
  }

  // ── Night shelter ────────────────────────────────────────────────────────────

  async _handleShelter(bot) {
    if (!bot || !bot.entity) return;
    const pos = bot.entity.position;
    this._log('[survivalV2:' + this._botId + '] 🌙 Seeking shelter (' +
              Math.round(pos.x) + ',' + Math.round(pos.y) + ',' + Math.round(pos.z) + ')');
    this._reportHiveTask('sheltering');

    // Already under a roof?
    if (this._isRoofed(bot)) {
      this._sheltered = true;
      _stopMovement(bot);
      this._log('[survivalV2:' + this._botId + '] Already sheltered — staying put');
      return;
    }

    // Look for natural shelter within SHELTER_RADIUS blocks
    const found = this._findNearbyShelter(bot);
    if (found) {
      try {
        await pathfinding.goToCoords(bot, found.x, found.y, found.z, 2);
        if (this._isRoofed(bot)) {
          this._sheltered  = true;
          this._shelterPos = found;
          _stopMovement(bot);
          this._log('[survivalV2:' + this._botId + '] Moved into shelter at ' +
                    Math.round(found.x) + ',' + Math.round(found.y) + ',' + Math.round(found.z));
          return;
        }
      } catch (_) {}
    }

    // Build an emergency dirt hut
    await this._buildEmergencyShelter(bot);
  }

  // ── Eating helpers ────────────────────────────────────────────────────────────

  /**
   * Eat the best food item in inventory.
   * Uses mineflayer-auto-eat if loaded, falls back to manual equip+consume.
   * Returns true if something was eaten.
   */
  async _eatBestFood(bot, emergency) {
    if (!bot || !bot.entity) return false;
    const threshold = emergency ? 20 : HUNGER_EAT;

    if (bot.autoEat && bot.autoEat.eat && typeof bot.food === 'number' && bot.food < threshold) {
      try { await bot.autoEat.eat(); return true; } catch (_) {}
    }

    for (const name of FOOD_PRIORITY) {
      const item = bot.inventory.items().find(i => i.name === name);
      if (item) {
        try {
          await bot.equip(item, 'hand');
          await bot.consume();
          return true;
        } catch (_) {}
      }
    }
    return false;
  }

  // ── Hunt & forage helpers ────────────────────────────────────────────────────

  async _hunt(bot) {
    if (!bot || !bot.entity) return false;
    const animal = bot.nearestEntity(e =>
      Array.isArray(survival.ANIMALS) && survival.ANIMALS.includes(e.name) &&
      e.position && bot.entity.position.distanceTo(e.position) <= 32
    );
    if (!animal) return false;
    try {
      await pathfinding.goToCoords(bot, animal.position.x, animal.position.y, animal.position.z, 2);
      await combat.attackMob(bot, animal);
      await _sleep(1800);
      // Collect any drops
      const drop = bot.nearestEntity(e =>
        e.name === 'item' && e.position &&
        bot.entity.position.distanceTo(e.position) <= 8
      );
      if (drop) {
        try {
          await bot.pathfinder.goto(
            new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1)
          );
        } catch (_) {}
      }
      return true;
    } catch (_) { return false; }
  }

  async _collectNearbyFood(bot) {
    if (!bot || !bot.entity) return false;
    const drop = bot.nearestEntity(e => {
      if (e.name !== 'item' || !e.metadata || !e.position) return false;
      return bot.entity.position.distanceTo(e.position) <= 16;
    });
    if (!drop) return false;
    try {
      pathfinding.setupMovements(bot);
      await bot.pathfinder.goto(
        new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1)
      );
      return true;
    } catch (_) { return false; }
  }

  // ── Hive Mind food sharing ────────────────────────────────────────────────────

  /**
   * Find a fleet-mate with food surplus and broadcast a food_request message.
   * Returns the meet-up position if a donor was found, or null.
   */
  _requestFoodFromHive(bot) {
    try {
      const hiveMind = require('../core/hiveMind');

      // Find the nearest bot that has enough food to share
      let bestId = null, bestCount = 0, bestDist = Infinity;

      for (const [bid, poolEntry] of hiveMind._pool.entries()) {
        if (bid === this._botId) continue;
        const foodCount = FOOD_PRIORITY.reduce((s, n) => s + (poolEntry.items[n] || 0), 0);
        if (foodCount < MIN_FOOD_RESERVE) continue;

        const entry = hiveMind._bots.get(bid);
        if (!entry || !entry.bot || !entry.bot.entity) continue;

        const dist = bot.entity.position.distanceTo(entry.bot.entity.position);
        if (foodCount > bestCount || (foodCount === bestCount && dist < bestDist)) {
          bestId    = bid;
          bestCount = foodCount;
          bestDist  = dist;
        }
      }

      if (!bestId) return null;

      const donorEntry = hiveMind._bots.get(bestId);
      if (!donorEntry || !donorEntry.bot || !donorEntry.bot.entity) return null;

      const meetPos = {
        x: donorEntry.bot.entity.position.x,
        y: donorEntry.bot.entity.position.y,
        z: donorEntry.bot.entity.position.z
      };

      hiveMind.broadcast('food_request', {
        requesterId: this._botId,
        donorId:     bestId,
        meetPos
      });
      if (typeof hiveMind._addIntel === 'function') {
        hiveMind._addIntel('system',
          '[' + this._botId + '] requesting food from ' + bestId +
          ' (' + bestCount + ' items)');
      }

      return meetPos;
    } catch (_) { return null; }
  }

  /**
   * Listen for food_request broadcasts directed at this bot.
   * When we are the chosen donor, drop a stack of the best food we have.
   */
  _attachHiveListener() {
    try {
      const hiveMind = require('../core/hiveMind');
      // hiveMind.broadcast() emits 'hive:broadcast' with { event, payload, at }
      this._hiveFoodListener = ({ event, payload }) => {
        if (event !== 'food_request') return;
        if (!payload || payload.donorId !== this._botId) return;
        const bot = this._bot;
        if (!bot || !bot.entity) return;
        // Drop half a stack of best available food for the requester
        for (const name of FOOD_PRIORITY) {
          const item = bot.inventory.items().find(i => i.name === name && i.count > MIN_FOOD_RESERVE);
          if (item) {
            const toDrop = Math.max(1, Math.floor(item.count / 2));
            bot.toss(item.type, null, toDrop).catch(() => {});
            this._log('[survivalV2:' + this._botId + '] Shared ' + toDrop + 'x ' +
                      name + ' → ' + payload.requesterId);
            break;
          }
        }
      };
      hiveMind.on('hive:broadcast', this._hiveFoodListener);
    } catch (_) {}
  }

  _detachHiveListener() {
    try {
      if (!this._hiveFoodListener) return;
      const hiveMind = require('../core/hiveMind');
      hiveMind.removeListener('hive:broadcast', this._hiveFoodListener);
      this._hiveFoodListener = null;
    } catch (_) {}
  }

  // ── Shelter detection helpers ────────────────────────────────────────────────

  _isNight(bot) {
    try {
      const t = bot.time && bot.time.timeOfDay;
      return typeof t === 'number' && t >= DUSK_TICKS && t < DAWN_TICKS;
    } catch (_) { return false; }
  }

  /**
   * Returns true if there is a solid block above the bot within SHELTER_ROOF_DEPTH.
   */
  _isRoofed(bot) {
    if (!bot || !bot.entity) return false;
    try {
      const px = Math.floor(bot.entity.position.x);
      const py = Math.floor(bot.entity.position.y);
      const pz = Math.floor(bot.entity.position.z);
      for (let dy = 1; dy <= SHELTER_ROOF_DEPTH; dy++) {
        const b = bot.blockAt({ x: px, y: py + dy, z: pz });
        if (b && b.boundingBox === 'block' &&
            b.name !== 'air' && b.name !== 'cave_air') {
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  /**
   * Scan SHELTER_RADIUS blocks around the bot for a position that has:
   *   - solid block as roof (within 2 blocks overhead)
   *   - two air blocks to stand in
   *   - solid floor
   *   - not in a registered hive danger zone
   *
   * Returns { x, y, z } or null.
   */
  _findNearbyShelter(bot) {
    if (!bot || !bot.entity) return null;
    try {
      const hiveMind = require('../core/hiveMind');
      const px = Math.floor(bot.entity.position.x);
      const py = Math.floor(bot.entity.position.y);
      const pz = Math.floor(bot.entity.position.z);

      for (let dx = -SHELTER_RADIUS; dx <= SHELTER_RADIUS; dx += 2) {
        for (let dz = -SHELTER_RADIUS; dz <= SHELTER_RADIUS; dz += 2) {
          const cx = px + dx, cz = pz + dz;

          // Check danger zone first
          if (hiveMind.isDangerZone && hiveMind.isDangerZone(cx, py, cz, 3)) continue;

          const floor  = bot.blockAt({ x: cx, y: py - 1, z: cz });
          const feet   = bot.blockAt({ x: cx, y: py,     z: cz });
          const head   = bot.blockAt({ x: cx, y: py + 1, z: cz });
          const roof   = bot.blockAt({ x: cx, y: py + 2, z: cz });

          if (!floor || floor.boundingBox !== 'block') continue;
          if (!feet  || feet.name !== 'air') continue;
          if (!head  || head.name !== 'air') continue;
          if (!roof  || roof.boundingBox !== 'block' ||
              roof.name === 'air' || roof.name === 'cave_air') continue;

          return { x: cx, y: py, z: cz };
        }
      }
    } catch (_) {}
    return null;
  }

  /**
   * Build a minimal emergency shelter: place 5 solid blocks in a + pattern
   * two blocks above the bot's feet so they have a roof to hide under.
   * Requires at least 4 solid blocks in inventory.
   */
  async _buildEmergencyShelter(bot) {
    if (!bot || !bot.entity) return;

    const buildItem = BUILD_MATERIALS.reduce((found, name) => {
      if (found) return found;
      return bot.inventory.items().find(i => i.name === name && i.count >= 5) || null;
    }, null);

    if (!buildItem) {
      this._log('[survivalV2:' + this._botId + '] No shelter materials — staying exposed');
      this._sheltered = true; // prevent repeated checks this night
      return;
    }

    this._log('[survivalV2:' + this._botId + '] Building emergency shelter with ' + buildItem.name);
    try {
      await bot.equip(buildItem, 'hand');

      const px = Math.floor(bot.entity.position.x);
      const py = Math.floor(bot.entity.position.y);
      const pz = Math.floor(bot.entity.position.z);

      // Place a roof directly above the bot's head level (py+2).
      // We need a solid reference block to place against.
      // Strategy: look for any solid block at (px, py+1, pz+1) or similar
      // and face-place against it.
      const offsets = [[0,0,1],[0,0,-1],[1,0,0],[-1,0,0],[0,1,0]];
      let placed = 0;
      for (const [ox, oy, oz] of offsets) {
        if (placed >= 5) break;
        const refPos = { x: px + ox, y: py + 2 + oy, z: pz + oz };
        const ref = bot.blockAt(refPos);
        if (!ref || ref.boundingBox !== 'block' || ref.name === 'air') continue;

        // Target block to fill (above bot's head)
        const target = { x: px, y: py + 2, z: pz };
        const existing = bot.blockAt(target);
        if (existing && existing.name !== 'air' && existing.name !== 'cave_air') { placed++; continue; }

        // Determine face vector from ref to target
        const face = new (require('vec3').Vec3)(
          target.x - refPos.x, target.y - refPos.y, target.z - refPos.z
        );
        try {
          await bot.placeBlock(ref, face);
          placed++;
          await _sleep(200);
        } catch (_) {}
      }

      this._sheltered    = true;
      this._builtShelter = true;
      this._shelterPos   = { x: px, y: py, z: pz };
      this._log('[survivalV2:' + this._botId + '] Emergency shelter built (' + placed + ' blocks placed)');
    } catch (err) {
      this._log('[survivalV2:' + this._botId + '] Shelter build error: ' + _msg(err));
      this._sheltered = true; // prevent repeated failures this night
    }
  }

  // ── Flee helpers ────────────────────────────────────────────────────────────

  async _fleeFrom(bot, mobPos, distance) {
    if (!bot || !bot.entity) return;
    try {
      const bp  = bot.entity.position;
      const dx  = bp.x - mobPos.x;
      const dz  = bp.z - mobPos.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const tx  = Math.round(bp.x + (dx / len) * distance);
      const tz  = Math.round(bp.z + (dz / len) * distance);
      pathfinding.setupMovements(bot);
      await bot.pathfinder.goto(new goals.GoalNear(tx, bp.y, tz, 2));
    } catch (_) {}
  }

  // ── Entity helpers ────────────────────────────────────────────────────────────

  _nearestHostile(bot, maxRange) {
    if (!bot || !bot.entity) return null;
    return bot.nearestEntity(e => {
      if (!HOSTILE_SET.has(e.name)) return false;
      if (!e.position) return false;
      return bot.entity.position.distanceTo(e.position) <= maxRange;
    });
  }

  _needsArmor(bot) {
    if (!bot || !bot.inventory) return false;
    // Slots 5-8 are helmet/chest/legs/boots in mineflayer
    const equipped = [5, 6, 7, 8].some(s => bot.inventory.slots[s] != null);
    if (equipped) return false;
    const armorSuffixes = ['helmet', 'chestplate', 'leggings', 'boots'];
    return bot.inventory.items().some(i => armorSuffixes.some(s => i.name.endsWith(s)));
  }

  // ── Hive task reporting ──────────────────────────────────────────────────────

  _reportHiveTask(taskName) {
    if (!this._botId) return;
    try {
      const hiveMind = require('../core/hiveMind');
      const entry = hiveMind._bots && hiveMind._bots.get(this._botId);
      if (!entry) return;
      const changed = entry.survivalState !== taskName;
      entry.survivalState = taskName;
      if (taskName !== 'idle') entry.currentTask = 'survival:' + taskName;
      // Only emit hive:update on state transitions (not every idle tick)
      if (changed) {
        hiveMind.emit('hive:update', hiveMind._statusSnapshot());
      }
    } catch (_) {}
  }

  // ── Utilities ────────────────────────────────────────────────────────────────

  _setState(s) {
    if (this._state !== s) this._state = s;
  }

  _log(msg) {
    if (typeof this._onLog === 'function') this._onLog(msg);
  }
}

// ── Module helpers ────────────────────────────────────────────────────────────

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function _msg(err)  { return err && err.message ? err.message : String(err); }

function _stopMovement(bot) {
  if (!bot) return;
  try {
    if (bot.pathfinder) { bot.pathfinder.setGoal(null); bot.pathfinder.stop(); }
    ['forward', 'back', 'left', 'right', 'sprint', 'sneak'].forEach(k => {
      try { bot.setControlState(k, false); } catch (_) {}
    });
  } catch (_) {}
}

/** Factory — always create a fresh SurvivalLoop per bot. */
function create() { return new SurvivalLoop(); }

module.exports = { create, SurvivalLoop };
