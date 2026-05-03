'use strict';

/**
 * FAERO — CombatAI (modules/combatAI.js)
 *
 * Active combat loop with mob-specific tactics, health-aware retreat,
 * re-engagement, and post-combat loot collection.
 *
 * Replaces the flat 5-second `await wait(5000)` in combat.js with a
 * sustained loop that monitors health every attack cycle and reacts
 * accordingly. All thresholds are configurable via env vars.
 *
 * Public API:
 *   engageMob(bot, entity, opts)      — main entry point (live entity ref)
 *   engageMobByName(bot, name, opts)  — find nearest by name, then engage
 *   guardianEngage(bot, range)        — instant nearest-hostile engagement
 *   retreat(bot, mobPosition)         — raw retreat helper (exported for reuse)
 *   collectDrops(bot, position)       — collect item drops after kill
 */

const pathfinding = require('./pathfinding');
const survival    = require('./survival');
const combat      = require('./combat');
const { goals }   = require('mineflayer-pathfinder');

// ── Configurable thresholds (all overridable via env) ─────────────────────────
const RETREAT_HEALTH      = Number(process.env.COMBAT_RETREAT_HEALTH)      || 6;
const REENGAGE_HEALTH     = Number(process.env.COMBAT_REENGAGE_HEALTH)     || 14;
const RETREAT_DISTANCE    = Number(process.env.COMBAT_RETREAT_DISTANCE)    || 12;
const SWORD_COOLDOWN_MS   = Number(process.env.COMBAT_SWORD_COOLDOWN_MS)   || 650;
const MAX_CHASE_DISTANCE  = Number(process.env.COMBAT_MAX_CHASE_DISTANCE)  || 30;
const DROP_COLLECT_RANGE  = Number(process.env.COMBAT_DROP_COLLECT_RANGE)  || 6;
const ENGAGE_TIMEOUT_MS   = Number(process.env.COMBAT_ENGAGE_TIMEOUT_MS)   || 30000;
const MAX_RETREATS        = 3;   // give up after this many retreats in one fight

// ── Mob-specific tactics ──────────────────────────────────────────────────────
//   minRange:      preferred distance to maintain from mob (blocks)
//   retreatHealth: HP threshold override for this mob (default RETREAT_HEALTH)
//   preferRanged:  hint for future ranged combat module
//   avoidDirectLook: look at feet instead of eyes (enderman)
//   note:          human-readable reason (logged, not acted on)
const MOB_TACTICS = {
  creeper:        { minRange: 5,  retreatHealth: 10, preferRanged: true,  note: 'keep 5+ blocks — explosion radius 3–6' },
  skeleton:       { minRange: 1,  preferRanged: false, note: 'close fast to deny arrow shots' },
  stray:          { minRange: 1,  preferRanged: false, note: 'close fast — slowness arrows' },
  spider:         { minRange: 1,  preferRanged: false, note: 'standard melee' },
  cave_spider:    { minRange: 1,  retreatHealth: 14, preferRanged: false, note: 'poison — retreat quickly' },
  enderman:       { minRange: 1,  avoidDirectLook: true, preferRanged: false, note: 'look at feet' },
  witch:          { minRange: 3,  retreatHealth: 12, preferRanged: true,  note: 'potions — keep range' },
  blaze:          { minRange: 4,  retreatHealth: 10, preferRanged: true,  note: 'fire — stay at range' },
  ghast:          { minRange: 8,  preferRanged: true,  note: 'deflect fireball or bow' },
  zombie:         { minRange: 1,  preferRanged: false, note: 'standard melee' },
  husk:           { minRange: 1,  preferRanged: false, note: 'hunger effect — standard melee' },
  drowned:        { minRange: 1,  preferRanged: false, note: 'trident — stay close' },
  phantom:        { minRange: 1,  preferRanged: false, note: 'dive attacks — track overhead' },
  pillager:       { minRange: 2,  retreatHealth: 8,  preferRanged: true,  note: 'crossbow — return fire or close fast' },
  vindicator:     { minRange: 1,  retreatHealth: 8,  preferRanged: false, note: 'high melee damage' },
  evoker:         { minRange: 1,  retreatHealth: 10, preferRanged: false, note: 'fang+vex — priority kill' },
  ravager:        { minRange: 1,  retreatHealth: 6,  preferRanged: false, note: 'high HP — sustained fight' },
  guardian:       { minRange: 1,  retreatHealth: 8,  preferRanged: false, note: 'beam in water' },
  elder_guardian: { minRange: 1,  retreatHealth: 6,  preferRanged: false, note: 'mining fatigue — get out of water' },
  magma_cube:     { minRange: 1,  preferRanged: false, note: 'splits — kill smallest last' },
  slime:          { minRange: 1,  preferRanged: false, note: 'splits — kill smallest last' },
  wither_skeleton:{ minRange: 1,  retreatHealth: 10, preferRanged: false, note: 'wither effect — fast retreat' },
  piglin_brute:   { minRange: 1,  retreatHealth: 8,  preferRanged: false, note: 'high damage' },
  zoglin:         { minRange: 1,  retreatHealth: 8,  preferRanged: false, note: 'knockback' }
};
const DEFAULT_TACTIC = { minRange: 1, preferRanged: false };

// ── Weapon helpers ────────────────────────────────────────────────────────────
const SWORD_NAMES = [
  'netherite_sword', 'diamond_sword', 'iron_sword',
  'stone_sword', 'golden_sword', 'wooden_sword'
];
const BOW_NAMES = ['bow', 'crossbow'];

function findBestSword(bot) {
  for (const name of SWORD_NAMES) {
    const item = bot.inventory.items().find(i => i.name === name);
    if (item) return item;
  }
  return null;
}

function findBow(bot) {
  for (const name of BOW_NAMES) {
    const item = bot.inventory.items().find(i => i.name === name);
    if (item) return item;
  }
  return null;
}

function hasSword(bot) { return Boolean(findBestSword(bot)); }
function hasBow(bot)   { return Boolean(findBow(bot)); }

async function equipSword(bot) {
  const sword = findBestSword(bot);
  if (!sword) return false;
  try { await bot.equip(sword, 'hand'); return true; } catch (_) { return false; }
}

// ── Retreat ───────────────────────────────────────────────────────────────────
/**
 * Sprint away from mob position by RETREAT_DISTANCE blocks.
 * Races pathfinder goal against a 3s timeout so we never stall.
 */
async function retreat(bot, mobPosition) {
  if (!bot || !bot.entity) return;
  try { bot.pathfinder.stop(); } catch (_) {}

  const myPos = bot.entity.position;
  const dx  = myPos.x - mobPosition.x;
  const dz  = myPos.z - mobPosition.z;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  const rx  = myPos.x + (dx / len) * RETREAT_DISTANCE;
  const rz  = myPos.z + (dz / len) * RETREAT_DISTANCE;

  pathfinding.setupMovements(bot);
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(rx, myPos.y, rz, 2)),
      sleep(3500)
    ]);
  } catch (_) {
    bot.clearControlStates();
  }
}

// ── Health recovery wait ──────────────────────────────────────────────────────
/**
 * Attempt to eat and wait until health reaches `threshold` or timeout expires.
 * Returns true if threshold was reached.
 */
async function waitForHealth(bot, threshold, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  while (Date.now() < deadline) {
    if (!bot || !bot.entity) return false;
    if (bot.health >= threshold) return true;
    await tryEat(bot);
    await sleep(600);
  }
  return Boolean(bot && bot.health >= threshold);
}

async function tryEat(bot) {
  try {
    if (bot.autoEat && bot.autoEat.eat && bot.food < 20) {
      await bot.autoEat.eat();
    } else {
      await survival.autoEat(bot);
    }
  } catch (_) {}
}

// ── Post-combat loot collection ───────────────────────────────────────────────
/**
 * Scan for item entities near killPosition and navigate to each one.
 * Capped at 8 drops, 3s per drop, best-effort only — never throws.
 */
async function collectDrops(bot, killPosition) {
  if (!bot || !bot.entity) return;
  const origin = killPosition || bot.entity.position;

  const drops = Object.values(bot.entities || {}).filter(e => {
    if (!e || e.name !== 'item' || !e.position) return false;
    return origin.distanceTo(e.position) <= DROP_COLLECT_RANGE;
  });

  if (!drops.length) return;

  pathfinding.setupMovements(bot);
  for (const drop of drops.slice(0, 8)) {
    if (!bot || !bot.entity) return;
    try {
      await Promise.race([
        bot.pathfinder.goto(
          new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1)
        ),
        sleep(3000)
      ]);
    } catch (_) {}
  }
}

// ── Core engagement loop ──────────────────────────────────────────────────────
/**
 * Engage a single mob entity with the full combat AI loop.
 *
 *  Phase 1 — Pre-combat: equip best sword
 *  Phase 2 — Loop:
 *    a. Verify mob still alive (in bot.entities)
 *    b. Chase-distance guard (give up if mob > MAX_CHASE_DISTANCE)
 *    c. Health check → retreat + eat + re-engage if below retreatHealth
 *    d. Approach to tactic.minRange + 1
 *    e. Look at target (feet for enderman)
 *    f. Attack (pvp.attack preferred, bot.attack fallback)
 *    g. Wait SWORD_COOLDOWN_MS before next hit
 *  Phase 3 — Post-combat: collect drops near last known position
 *
 * @param {object}  bot     Mineflayer bot instance
 * @param {object}  entity  Live entity reference (from bot.entities)
 * @param {object}  [opts]
 * @param {number}  [opts.retreatHealth]  HP override to trigger retreat
 * @param {number}  [opts.reEngageHealth] HP required before re-engaging
 * @param {object}  [opts.signal]         { aborted: boolean } external cancel
 * @returns {Promise<{result:'killed'|'retreated'|'lost'|'offline', looted:boolean}>}
 */
async function engageMob(bot, entity, opts) {
  if (!bot || !bot.entity)  return { result: 'offline',  looted: false };
  if (!entity || !entity.id) return { result: 'lost',    looted: false };

  const tactic     = MOB_TACTICS[entity.name] || DEFAULT_TACTIC;
  const retreatAt  = (opts && opts.retreatHealth  != null ? opts.retreatHealth  : tactic.retreatHealth)  || RETREAT_HEALTH;
  const reEngageAt = (opts && opts.reEngageHealth != null ? opts.reEngageHealth : REENGAGE_HEALTH);
  const signal     = opts && opts.signal;

  // ── Pre-combat: equip sword ────────────────────────────────────────────────
  await equipSword(bot);

  const deadline      = Date.now() + ENGAGE_TIMEOUT_MS;
  let   retreatCount  = 0;
  let   lastKnownPos  = entity.position ? entity.position.clone() : bot.entity.position.clone();

  while (Date.now() < deadline) {
    // ── External cancel signal ───────────────────────────────────────────────
    if (signal && signal.aborted) break;
    if (!bot || !bot.entity) return { result: 'offline', looted: false };

    // ── Check mob still alive ────────────────────────────────────────────────
    const live = bot.entities[entity.id];
    if (!live || !live.position) {
      // Mob despawned = dead — collect drops
      const looted = await collectDropsSafe(bot, lastKnownPos);
      return { result: 'killed', looted };
    }
    lastKnownPos = live.position.clone();

    const dist = bot.entity.position.distanceTo(live.position);

    // ── Chase distance guard ─────────────────────────────────────────────────
    if (dist > MAX_CHASE_DISTANCE) {
      return { result: 'lost', looted: false };
    }

    // ── Health check — retreat branch ────────────────────────────────────────
    if (bot.health <= retreatAt) {
      retreatCount++;
      if (retreatCount > MAX_RETREATS) {
        // Multiple retreats without recovery — abort
        try { bot.pathfinder.stop(); } catch (_) {}
        return { result: 'retreated', looted: false };
      }

      try { bot.pathfinder.stop(); } catch (_) {}
      await retreat(bot, live.position);
      await tryEat(bot);
      const recovered = await waitForHealth(bot, reEngageAt, 8000);
      if (!recovered) return { result: 'retreated', looted: false };

      // Re-equip sword after eating (food may have swapped hand slot)
      await equipSword(bot);
      continue;
    }

    // ── Approach to melee range ──────────────────────────────────────────────
    const targetRange = (tactic.minRange || 1) + 1;
    if (dist > targetRange) {
      pathfinding.setupMovements(bot);
      try {
        await Promise.race([
          bot.pathfinder.goto(
            new goals.GoalNear(live.position.x, live.position.y, live.position.z, tactic.minRange || 1)
          ),
          sleep(2500)
        ]);
      } catch (_) {}
      continue; // Re-evaluate after move
    }

    // ── Look at target ───────────────────────────────────────────────────────
    try {
      if (tactic.avoidDirectLook) {
        // Enderman: aim at feet to avoid triggering aggro
        await bot.lookAt(live.position.offset(0, 0.1, 0), false);
      } else {
        const eyeHeight = (live.height != null ? live.height : 1.8) * 0.85;
        await bot.lookAt(live.position.offset(0, eyeHeight, 0), false);
      }
    } catch (_) {}

    // ── Attack ───────────────────────────────────────────────────────────────
    try {
      if (bot.pvp && bot.pvp.attack) {
        bot.pvp.attack(live);
      } else {
        bot.attack(live);
      }
    } catch (_) {}

    // Respect sword attack cooldown before next hit
    await sleep(SWORD_COOLDOWN_MS);
  }

  // Engage timeout reached
  try { bot.pathfinder.stop(); } catch (_) {}
  return { result: 'lost', looted: false };
}

async function collectDropsSafe(bot, position) {
  try { await collectDrops(bot, position); return true; } catch (_) { return false; }
}

// ── Named-mob helper ──────────────────────────────────────────────────────────
/**
 * Scan for nearest mob matching `name` within MAX_CHASE_DISTANCE, then engage.
 * Used by in-game commands: !target <mob>
 */
async function engageMobByName(bot, name, opts) {
  if (!bot || !bot.entity) return { result: 'offline', looted: false };
  const entity = bot.nearestEntity(e =>
    e.name &&
    e.name.toLowerCase().includes(name.toLowerCase()) &&
    e.type === 'mob' &&
    bot.entity.position.distanceTo(e.position) <= MAX_CHASE_DISTANCE
  );
  if (!entity) return { result: 'not_found', looted: false };
  return engageMob(bot, entity, opts);
}

// ── Guardian instant-engage ───────────────────────────────────────────────────
/**
 * Find nearest hostile mob within `range` blocks and immediately engage.
 * Designed for guardian mode — skips the task queue for instant response.
 * Returns null if no mob found.
 */
async function guardianEngage(bot, range) {
  if (!bot || !bot.entity) return null;
  const mob = combat.nearestHostileMob(bot, range || 16);
  if (!mob) return null;
  return engageMob(bot, mob, {});
}

// ── Utility ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  MOB_TACTICS,
  SWORD_NAMES,
  BOW_NAMES,
  hasSword,
  hasBow,
  findBestSword,
  findBow,
  equipSword,
  retreat,
  waitForHealth,
  collectDrops,
  engageMob,
  engageMobByName,
  guardianEngage,
  RETREAT_HEALTH,
  REENGAGE_HEALTH,
  RETREAT_DISTANCE,
  MAX_CHASE_DISTANCE,
  SWORD_COOLDOWN_MS
};
