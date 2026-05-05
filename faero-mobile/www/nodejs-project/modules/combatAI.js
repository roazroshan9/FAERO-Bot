'use strict';

/**
 * FAERO — CombatAI (modules/combatAI.js)
 *
 * Active combat loop with mob-specific tactics, health-aware retreat,
 * re-engagement, shield blocking, anti-trap detection, and post-combat
 * loot collection.
 *
 * New in this version:
 *   • Shield equip + blocking (offhand slot) — activates at low HP or vs
 *     projectile-firing mobs (skeleton, blaze, ghast, etc.)
 *   • Anti-trap detection — escapes cobwebs (breaks them), lava proximity
 *     (immediate retreat), and 1×1 hole detection (jumps / digs up)
 *   • opts.onEngage(name) callback — lets callers track _lastCombatTarget
 *
 * Public API:
 *   engageMob(bot, entity, opts)      — main entry point
 *   engageMobByName(bot, name, opts)  — find nearest, then engage
 *   guardianEngage(bot, range)        — instant nearest-hostile engagement
 *   retreat(bot, mobPosition)         — raw retreat helper
 *   collectDrops(bot, position)       — collect item drops after kill
 */

const pathfinding = require('./pathfinding');
const survival    = require('./survival');
const combat      = require('./combat');
const { goals }   = require('mineflayer-pathfinder');
const Vec3        = require('vec3').Vec3;

// ── Configurable thresholds ───────────────────────────────────────────────────
const RETREAT_HEALTH      = Number(process.env.COMBAT_RETREAT_HEALTH)      || 6;
const REENGAGE_HEALTH     = Number(process.env.COMBAT_REENGAGE_HEALTH)     || 14;
const RETREAT_DISTANCE    = Number(process.env.COMBAT_RETREAT_DISTANCE)    || 12;
const SWORD_COOLDOWN_MS   = Number(process.env.COMBAT_SWORD_COOLDOWN_MS)   || 650;
const MAX_CHASE_DISTANCE  = Number(process.env.COMBAT_MAX_CHASE_DISTANCE)  || 30;
const DROP_COLLECT_RANGE  = Number(process.env.COMBAT_DROP_COLLECT_RANGE)  || 6;
const ENGAGE_TIMEOUT_MS   = Number(process.env.COMBAT_ENGAGE_TIMEOUT_MS)   || 30000;
const SHIELD_HP_THRESHOLD = 10;   // activate shield at or below this HP (50% of 20)
const MAX_RETREATS        = 3;

// ── Mob-specific tactics ──────────────────────────────────────────────────────
const MOB_TACTICS = {
  creeper:        { minRange: 5,  retreatHealth: 10, preferRanged: true,  note: 'explosion radius 3–6' },
  skeleton:       { minRange: 1,  preferRanged: false, projectile: true,   note: 'close fast to deny arrows' },
  stray:          { minRange: 1,  preferRanged: false, projectile: true,   note: 'slowness arrows' },
  spider:         { minRange: 1,  preferRanged: false, note: 'standard melee' },
  cave_spider:    { minRange: 1,  retreatHealth: 14, preferRanged: false, note: 'poison — retreat quickly' },
  enderman:       { minRange: 1,  avoidDirectLook: true, preferRanged: false, note: 'look at feet' },
  witch:          { minRange: 3,  retreatHealth: 12, preferRanged: true,  projectile: true, note: 'potions' },
  blaze:          { minRange: 4,  retreatHealth: 10, preferRanged: true,  projectile: true, note: 'fire' },
  ghast:          { minRange: 8,  preferRanged: true, projectile: true,   note: 'deflect or bow' },
  zombie:         { minRange: 1,  preferRanged: false, note: 'standard melee' },
  husk:           { minRange: 1,  preferRanged: false, note: 'hunger' },
  drowned:        { minRange: 1,  preferRanged: false, projectile: true,   note: 'trident' },
  phantom:        { minRange: 1,  preferRanged: false, note: 'dive attacks' },
  pillager:       { minRange: 2,  retreatHealth: 8,  preferRanged: true, projectile: true, note: 'crossbow' },
  vindicator:     { minRange: 1,  retreatHealth: 8,  preferRanged: false, note: 'high melee' },
  evoker:         { minRange: 1,  retreatHealth: 10, preferRanged: false, note: 'fang+vex — priority kill' },
  ravager:        { minRange: 1,  retreatHealth: 6,  preferRanged: false, note: 'high HP' },
  guardian:       { minRange: 1,  retreatHealth: 8,  preferRanged: false, note: 'beam in water' },
  elder_guardian: { minRange: 1,  retreatHealth: 6,  preferRanged: false, note: 'mining fatigue' },
  magma_cube:     { minRange: 1,  preferRanged: false, note: 'splits' },
  slime:          { minRange: 1,  preferRanged: false, note: 'splits' },
  wither_skeleton:{ minRange: 1,  retreatHealth: 10, preferRanged: false, note: 'wither effect' },
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
function findBow(bot)   { return BOW_NAMES.map(n => bot.inventory.items().find(i => i.name === n)).find(Boolean) || null; }
function hasSword(bot)  { return Boolean(findBestSword(bot)); }
function hasBow(bot)    { return Boolean(findBow(bot)); }

async function equipSword(bot) {
  const sword = findBestSword(bot);
  if (!sword) return false;
  try { await bot.equip(sword, 'hand'); return true; } catch (_) { return false; }
}

// ── Shield helpers ────────────────────────────────────────────────────────────

function findShield(bot) {
  return bot.inventory.items().find(i => i.name === 'shield') || null;
}

/** Returns true when a shield is currently in the offhand slot (slot 45). */
function isShieldInOffhand(bot) {
  try {
    const slot = bot.inventory.slots[45];
    return Boolean(slot && slot.name === 'shield');
  } catch (_) { return false; }
}

/**
 * Equip a shield to the offhand slot.  Returns true on success.
 * Silently skips if no shield in inventory.
 */
async function equipShield(bot) {
  if (isShieldInOffhand(bot)) return true;
  const shield = findShield(bot);
  if (!shield) return false;
  try {
    await bot.equip(shield, 'off-hand');
    return true;
  } catch (_) { return false; }
}

/**
 * Activate the shield (right-click hold with offhand).
 * No-op if shield is not in offhand.
 */
async function activateShield(bot) {
  if (!isShieldInOffhand(bot)) return false;
  try {
    bot.activateItem(false); // false → offhand slot
    return true;
  } catch (_) { return false; }
}

/** Deactivate (stop blocking). Safe to call even when not blocking. */
function deactivateShield(bot) {
  try { bot.deactivateItem(); } catch (_) {}
}

// ── Anti-Trap Detection ───────────────────────────────────────────────────────

const LAVA_NAMES = ['lava', 'flowing_lava'];
const COBWEB_NAME = 'cobweb';

/**
 * Detect and escape from common traps:
 *   cobweb  — break the cobweb block with active weapon
 *   lava    — sprint away from the nearest lava source
 *   1×1 pit — jump + sprint up when hemmed in on 4 sides at ground level
 *
 * Returns true if a trap was detected (caller should skip the normal attack
 * cycle for this iteration and let the bot recover first).
 */
async function checkAndEscapeTrap(bot) {
  if (!bot || !bot.entity) return false;

  const pos      = bot.entity.position;
  const feetPos  = new Vec3(Math.floor(pos.x), Math.floor(pos.y),     Math.floor(pos.z));
  const bodyPos  = new Vec3(Math.floor(pos.x), Math.floor(pos.y + 1), Math.floor(pos.z));

  // ── 1. Cobweb check ────────────────────────────────────────────────────────
  for (const checkPos of [feetPos, bodyPos]) {
    let block;
    try { block = bot.blockAt(checkPos); } catch (_) { continue; }
    if (block && block.name === COBWEB_NAME) {
      // Break the cobweb (swords are fastest — already equipped during combat)
      try {
        if (bot.canDigBlock(block)) {
          await Promise.race([bot.dig(block, true), sleep(1500)]);
        } else {
          // Swing anyway to destroy it (Mineflayer allows this in survival)
          bot.swingArm();
        }
      } catch (_) {}
      return true;
    }
  }

  // ── 2. Lava proximity check ────────────────────────────────────────────────
  for (const lavaName of LAVA_NAMES) {
    const lavaBlock = pathfinding.nearestBlock(bot, [lavaName], 3);
    if (lavaBlock) {
      const myPos = bot.entity.position;
      const lPos  = lavaBlock.position;
      const dx = myPos.x - lPos.x;
      const dz = myPos.z - lPos.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const tx  = myPos.x + (dx / len) * 10;
      const tz  = myPos.z + (dz / len) * 10;

      pathfinding.setupMovements(bot);
      try {
        await Promise.race([
          bot.pathfinder.goto(new goals.GoalNear(tx, myPos.y, tz, 2)),
          sleep(3000)
        ]);
      } catch (_) { bot.clearControlStates(); }
      return true;
    }
  }

  // ── 3. 1×1 pit check ──────────────────────────────────────────────────────
  // Heuristic: blocked on all 4 cardinal sides at torso height AND velocity ≈ 0
  const vel = bot.entity.velocity;
  const isStuck = vel && Math.abs(vel.x) < 0.01 && Math.abs(vel.z) < 0.01;
  if (isStuck) {
    const offsets = [[1,0],[-1,0],[0,1],[0,-1]];
    let wallCount = 0;
    for (const [dx, dz] of offsets) {
      try {
        const b = bot.blockAt(bodyPos.offset(dx, 0, dz));
        if (b && b.boundingBox === 'block') wallCount++;
      } catch (_) {}
    }
    if (wallCount >= 3) {
      // Try to jump-sprint out; if that fails, dig the block above
      try { bot.setControlState('jump', true); await sleep(400); bot.setControlState('jump', false); } catch (_) {}
      const above = bot.blockAt(bodyPos.offset(0, 1, 0));
      if (above && above.boundingBox === 'block' && bot.canDigBlock(above)) {
        try { await Promise.race([bot.dig(above), sleep(2000)]); } catch (_) {}
      }
      return true;
    }
  }

  return false;
}

// ── Retreat ───────────────────────────────────────────────────────────────────
async function retreat(bot, mobPosition) {
  if (!bot || !bot.entity) return;
  deactivateShield(bot);
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
  } catch (_) { bot.clearControlStates(); }
}

// ── Health recovery ───────────────────────────────────────────────────────────
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

// ── Post-combat loot ──────────────────────────────────────────────────────────
async function collectDrops(bot, killPosition) {
  if (!bot || !bot.entity) return;
  const origin = killPosition || bot.entity.position;
  const drops  = Object.values(bot.entities || {}).filter(e => {
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

async function collectDropsSafe(bot, position) {
  try { await collectDrops(bot, position); return true; } catch (_) { return false; }
}

// ── Core engagement loop ──────────────────────────────────────────────────────

/**
 * Engage a single mob entity with the full combat AI loop.
 *
 * @param {object}  bot
 * @param {object}  entity   — live entity ref from bot.entities
 * @param {object}  [opts]
 * @param {number}  [opts.retreatHealth]   — HP override to trigger retreat
 * @param {number}  [opts.reEngageHealth]  — HP required before re-engaging
 * @param {object}  [opts.signal]          — { aborted: boolean } cancel token
 * @param {Function}[opts.onEngage]        — called with entity.name at start
 *                                           (used to set _lastCombatTarget)
 * @returns {Promise<{result:'killed'|'retreated'|'lost'|'offline', looted:boolean}>}
 */
async function engageMob(bot, entity, opts) {
  if (!bot || !bot.entity)   return { result: 'offline',  looted: false };
  if (!entity || !entity.id) return { result: 'lost',     looted: false };

  const tactic     = MOB_TACTICS[entity.name] || DEFAULT_TACTIC;
  const retreatAt  = (opts && opts.retreatHealth  != null ? opts.retreatHealth  : tactic.retreatHealth)  || RETREAT_HEALTH;
  const reEngageAt = (opts && opts.reEngageHealth != null ? opts.reEngageHealth : REENGAGE_HEALTH);
  const signal     = opts && opts.signal;

  // ── Notify caller of mob name (for _lastCombatTarget tracking) ─────────────
  if (opts && typeof opts.onEngage === 'function') {
    try { opts.onEngage(entity.name); } catch (_) {}
  }

  // ── Pre-combat: equip best sword + shield ──────────────────────────────────
  await equipSword(bot);
  await equipShield(bot);   // no-op if no shield in inventory

  const isProjectileMob = Boolean(tactic.projectile);
  const deadline        = Date.now() + ENGAGE_TIMEOUT_MS;
  let   retreatCount    = 0;
  let   trapCheckAt     = 0;   // throttle trap checks to every 3s
  let   lastKnownPos    = entity.position
    ? entity.position.clone()
    : bot.entity.position.clone();

  while (Date.now() < deadline) {
    if (signal && signal.aborted) break;
    if (!bot || !bot.entity) return { result: 'offline', looted: false };

    // ── Mob still alive? ───────────────────────────────────────────────────
    const live = bot.entities[entity.id];
    if (!live || !live.position) {
      const looted = await collectDropsSafe(bot, lastKnownPos);
      return { result: 'killed', looted };
    }
    lastKnownPos = live.position.clone();

    const dist = bot.entity.position.distanceTo(live.position);

    // ── Chase distance guard ───────────────────────────────────────────────
    if (dist > MAX_CHASE_DISTANCE) {
      deactivateShield(bot);
      return { result: 'lost', looted: false };
    }

    // ── Anti-trap check (every 3 s) ────────────────────────────────────────
    const now = Date.now();
    if (now - trapCheckAt >= 3000) {
      trapCheckAt = now;
      const trapped = await checkAndEscapeTrap(bot);
      if (trapped) {
        await sleep(400);
        continue; // re-evaluate after escape attempt
      }
    }

    // ── Health check — retreat branch ──────────────────────────────────────
    if (bot.health <= retreatAt) {
      deactivateShield(bot);
      retreatCount++;
      if (retreatCount > MAX_RETREATS) {
        try { bot.pathfinder.stop(); } catch (_) {}
        return { result: 'retreated', looted: false };
      }
      try { bot.pathfinder.stop(); } catch (_) {}
      await retreat(bot, live.position);
      await tryEat(bot);
      const recovered = await waitForHealth(bot, reEngageAt, 8000);
      if (!recovered) return { result: 'retreated', looted: false };
      await equipSword(bot);
      await equipShield(bot);
      continue;
    }

    // ── Approach to melee range ────────────────────────────────────────────
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
      continue;
    }

    // ── Shield activation ──────────────────────────────────────────────────
    const needsShield = bot.health <= SHIELD_HP_THRESHOLD || isProjectileMob;
    if (needsShield && isShieldInOffhand(bot)) {
      await activateShield(bot);
      await sleep(250); // hold block briefly before swinging
    }

    // ── Look at target ─────────────────────────────────────────────────────
    try {
      if (tactic.avoidDirectLook) {
        await bot.lookAt(live.position.offset(0, 0.1, 0), false);
      } else {
        const eyeH = (live.height != null ? live.height : 1.8) * 0.85;
        await bot.lookAt(live.position.offset(0, eyeH, 0), false);
      }
    } catch (_) {}

    // ── Attack ────────────────────────────────────────────────────────────
    // Lower shield just before swinging (can't damage while fully blocking in Java)
    if (isShieldInOffhand(bot)) deactivateShield(bot);

    try {
      if (bot.pvp && bot.pvp.attack) {
        bot.pvp.attack(live);
      } else {
        bot.attack(live);
      }
    } catch (_) {}

    await sleep(SWORD_COOLDOWN_MS);
  }

  deactivateShield(bot);
  try { bot.pathfinder.stop(); } catch (_) {}
  return { result: 'lost', looted: false };
}

// ── Named-mob helper ──────────────────────────────────────────────────────────
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
async function guardianEngage(bot, range, opts) {
  if (!bot || !bot.entity) return null;
  const mob = combat.nearestHostileMob(bot, range || 16);
  if (!mob) return null;
  return engageMob(bot, mob, opts || {});
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
  equipShield,
  activateShield,
  deactivateShield,
  isShieldInOffhand,
  checkAndEscapeTrap,
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
  SWORD_COOLDOWN_MS,
  SHIELD_HP_THRESHOLD
};
