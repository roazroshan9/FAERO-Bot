'use strict';

/**
 * FAERO — Tactical Combat Engine (modules/tacticalCombat.js)
 *
 * Module 3: Tactical Combat Engine
 *
 * Provides coordinated fleet combat with:
 *   • Formation System  — Wedge, Pincer, Shield Wall
 *   • Role Assignment   — Tank, DPS, Support (auto or manual)
 *   • Focus-Fire        — Fleet-wide target lock on a single entity
 *   • Staggered Timing  — Each bot attacks in a time-sliced window
 *
 * ── Architecture ──────────────────────────────────────────────────────────────
 *
 *   TacticalEngine (singleton)
 *     ├── _formation   : null | 'wedge' | 'pincer' | 'shield_wall'
 *     ├── _roles       : Map<botId, 'tank'|'dps'|'support'>
 *     ├── _lockedTarget: null | { entityId, name, lastPos }
 *     └── _engageSlots : Map<botId, slotIndex>   ← stagger timing
 *
 *   Integration:
 *     fleetManager → calls engage() with all online bots
 *     hiveMind     → receives target lock / formation events
 *     web/server   → REST endpoints under /bot-api/tactical/*
 *
 * ── Formation geometry ────────────────────────────────────────────────────────
 *
 *   All offsets are relative to the locked target's position, in a coordinate
 *   space where +X is "away from target" and ±Z is "side to side".  The engine
 *   rotates these offsets to face the actual approach direction at runtime.
 *
 *   WEDGE   (▶)   Tank at apex, DPS spread 45° behind, Support at rear
 *   PINCER  (⊃⊂)  Fleet splits L/R, wraps around target flanks
 *   SHIELD WALL(▬) Tight horizontal line, Tank centre, DPS fill, Support rear
 */

const EventEmitter = require('events');
const { goals }    = require('mineflayer-pathfinder');
const Vec3         = require('vec3').Vec3;

// ── Constants ─────────────────────────────────────────────────────────────────

const ROLES           = Object.freeze({ TANK: 'tank', DPS: 'dps', SUPPORT: 'support' });
const FORMATIONS      = Object.freeze({ WEDGE: 'wedge', PINCER: 'pincer', SHIELD_WALL: 'shield_wall' });

const ENGAGE_RANGE    = 4;    // blocks — stop pathfinding and attack
const STAGGER_BASE_MS = 650;  // matches SWORD_COOLDOWN_MS default
const TARGET_TTL_MS   = 8000; // max ms since last seen before target is considered lost
const FORMATION_REACH = 6;    // blocks radius for formation positions around target

// ── Formation offset tables ───────────────────────────────────────────────────
// Each entry: [dx, dz] in target-relative space.
// dx = distance *from* target (positive = behind attacker POV)
// dz = lateral offset (positive = right flank, negative = left flank)
// Up to 8 positions — index wraps for larger fleets.

const FORMATION_OFFSETS = {
  wedge: [
    // slot 0 (Tank) — at the apex, closest to target
    [2,  0],
    // DPS wings spread behind the apex
    [4,  2], [4, -2],
    [6,  4], [6, -4],
    // Support stays back
    [8,  0],
    [8,  3], [8, -3]
  ],
  pincer: [
    // Left flank
    [3, -4], [5, -6], [7, -5],
    // Right flank
    [3,  4], [5,  6], [7,  5],
    // Centre reserve
    [6,  0], [8,  0]
  ],
  shield_wall: [
    // Tight horizontal line, close to target
    [3,  0],
    [3, -2], [3,  2],
    [3, -4], [3,  4],
    // Second rank support
    [6, -1], [6,  1], [6,  0]
  ]
};

// ── Sword quality order for Tank/DPS scoring ─────────────────────────────────
const SWORD_TIER = {
  netherite_sword: 6, diamond_sword: 5, iron_sword: 4,
  stone_sword: 3, golden_sword: 2, wooden_sword: 1
};

// ── Utility ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dist2D(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Rotate a 2-D [dx,dz] offset by `angle` radians around origin. */
function rotateOffset(dx, dz, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    Math.round(dx * cos - dz * sin),
    Math.round(dx * sin + dz * cos)
  ];
}

/**
 * Compute world-space formation position for a given slot around a target.
 * The formation always faces the approach direction (target → mean bot position).
 *
 * @param {string}    formation
 * @param {number}    slotIndex
 * @param {{x,y,z}}  targetPos
 * @param {{x,y,z}}  approachFrom   — reference point (e.g. leader pos) for rotation
 * @returns {{x,y,z}}
 */
function formationPosition(formation, slotIndex, targetPos, approachFrom) {
  const table   = FORMATION_OFFSETS[formation] || FORMATION_OFFSETS.wedge;
  const raw     = table[slotIndex % table.length];
  const dx_raw  = raw[0];
  const dz_raw  = raw[1];

  // Angle from target toward approach origin (so bots face target, stand behind)
  const angle = approachFrom
    ? Math.atan2(approachFrom.z - targetPos.z, approachFrom.x - targetPos.x)
    : 0;

  const [rdx, rdz] = rotateOffset(dx_raw, dz_raw, angle);
  return {
    x: targetPos.x + rdx,
    y: targetPos.y,
    z: targetPos.z + rdz
  };
}

// ── Role scorer ───────────────────────────────────────────────────────────────

/**
 * Score a bot for each role. Higher is better.
 * Returns { tank, dps, support }.
 */
function scoreBot(entry) {
  const b = entry.bot;
  if (!b || !b.entity) return { tank: 0, dps: 0, support: 0 };

  const health  = b.health  || 0;
  const food    = b.food    || 0;
  const items   = b.inventory ? b.inventory.items() : [];

  // Sword tier
  let swordScore = 0;
  let armorScore = 0;
  let foodScore  = 0;
  for (const it of items) {
    const tier = SWORD_TIER[it.name];
    if (tier && tier > swordScore) swordScore = tier;
    if (['cooked_beef', 'cooked_porkchop', 'bread', 'cooked_chicken',
         'cooked_mutton', 'cooked_salmon', 'golden_apple'].includes(it.name)) {
      foodScore += it.count;
    }
    if (['diamond_chestplate', 'iron_chestplate', 'netherite_chestplate'].includes(it.name)) armorScore += 3;
    if (['diamond_helmet',    'iron_helmet',    'netherite_helmet'   ].includes(it.name)) armorScore += 2;
    if (['diamond_leggings',  'iron_leggings',  'netherite_leggings' ].includes(it.name)) armorScore += 2;
    if (['diamond_boots',     'iron_boots',     'netherite_boots'    ].includes(it.name)) armorScore += 1;
  }

  return {
    tank:    health * 0.7 + armorScore * 3 + swordScore,
    dps:     swordScore * 4 + health * 0.3,
    support: foodScore * 2 + food * 0.5
  };
}

// ── Tactical Engine ───────────────────────────────────────────────────────────

class TacticalEngine extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(30);

    this._formation    = null;         // active formation name or null
    this._roles        = new Map();    // botId → role
    this._lockedTarget = null;         // { entityId, name, lastPos, lockedAt }
    this._engageSlots  = new Map();    // botId → slotIndex (for stagger)
    this._engageActive = false;        // whether a coordinated engage is running
    this._abortSignal  = { aborted: false };

    this._intelLog     = [];           // rolling log entries
    this._maxIntel     = 80;

    // Expose constants
    this.ROLES      = ROLES;
    this.FORMATIONS = FORMATIONS;
  }

  // ── Formation Management ──────────────────────────────────────────────────

  /**
   * Set the active formation.
   * Emits 'tactical:formation' with the new name.
   *
   * @param {'wedge'|'pincer'|'shield_wall'|null} name
   */
  setFormation(name) {
    const valid = name === null || Object.values(FORMATIONS).includes(name);
    if (!valid) throw new Error('Unknown formation: ' + name + '. Valid: wedge, pincer, shield_wall');
    this._formation = name;
    this._addIntel('formation', name
      ? 'Formation set → ' + name.toUpperCase().replace('_', ' ')
      : 'Formation cleared — free movement');
    this.emit('tactical:formation', { formation: name });
    return name;
  }

  getFormation() { return this._formation; }

  // ── Role Assignment ───────────────────────────────────────────────────────

  /**
   * Auto-assign roles to all registered bot entries.
   * Scores each bot then assigns the best fit to each role.
   * Remaining bots are assigned DPS.
   *
   * @param {Array<{id, role, bot, username}>} botEntries
   * @returns {Map<string, string>}  botId → role
   */
  assignRoles(botEntries) {
    if (!botEntries || !botEntries.length) return this._roles;

    const online = botEntries.filter(e => e.bot && e.bot.entity);
    if (!online.length) return this._roles;

    // Score every bot
    const scored = online.map(e => ({ id: e.id, username: e.username, score: scoreBot(e) }));

    // Pick best Tank — highest tank score
    scored.sort((a, b) => b.score.tank - a.score.tank);
    const tankId = scored[0].id;

    // Pick best Support — highest support score (excluding tank)
    const remaining = scored.filter(s => s.id !== tankId);
    remaining.sort((a, b) => b.score.support - a.score.support);
    const supportId = remaining.length > 1 ? remaining[0].id : null;

    // Assign roles
    this._roles.clear();
    this._engageSlots.clear();

    let slot = 0;
    for (const e of online) {
      let role;
      if (e.id === tankId)                  role = ROLES.TANK;
      else if (e.id === supportId)          role = ROLES.SUPPORT;
      else                                  role = ROLES.DPS;

      this._roles.set(e.id, role);
      this._engageSlots.set(e.id, slot++);
    }

    this._addIntel('roles', 'Roles assigned — ' +
      Array.from(this._roles.entries())
        .map(([id, r]) => id + ':' + r).join(', '));

    this.emit('tactical:roles', { roles: this.getRolesSnapshot() });
    return this._roles;
  }

  /**
   * Manually override a single bot's role.
   * @param {string} botId
   * @param {'tank'|'dps'|'support'} role
   */
  setRole(botId, role) {
    if (!Object.values(ROLES).includes(role)) throw new Error('Invalid role: ' + role);
    this._roles.set(botId, role);
    this._addIntel('roles', '[' + botId + '] role manually → ' + role);
    this.emit('tactical:roles', { roles: this.getRolesSnapshot() });
  }

  getRole(botId) { return this._roles.get(botId) || null; }

  getRolesSnapshot() {
    const out = {};
    for (const [id, r] of this._roles.entries()) out[id] = r;
    return out;
  }

  // ── Focus-Fire Target Locking ─────────────────────────────────────────────

  /**
   * Lock the entire fleet onto a single target entity.
   *
   * @param {string} botId        — bot that acquired the lock
   * @param {object} entity       — mineflayer entity ref
   */
  lockTarget(botId, entity) {
    if (!entity) return;
    const pos = entity.position
      ? { x: entity.position.x, y: entity.position.y, z: entity.position.z }
      : null;

    this._lockedTarget = {
      entityId: entity.id,
      name:     entity.name || entity.username || 'unknown',
      lastPos:  pos,
      lockedAt: Date.now(),
      lockedBy: botId
    };

    this._addIntel('combat', '🎯 Target locked: ' + this._lockedTarget.name +
      ' (id:' + entity.id + ') by ' + botId);
    this.emit('tactical:targetLocked', { ...this._lockedTarget });
    return this._lockedTarget;
  }

  /**
   * Refresh the locked target's last known position.
   * Call every tick inside the engage loop.
   */
  updateTargetPos(entity) {
    if (!this._lockedTarget) return;
    if (entity && entity.position) {
      this._lockedTarget.lastPos = {
        x: entity.position.x,
        y: entity.position.y,
        z: entity.position.z
      };
    }
  }

  /**
   * Clear the target lock (e.g. after kill or retreat).
   */
  clearTarget() {
    if (!this._lockedTarget) return;
    this._addIntel('combat', '🔓 Target lock cleared: ' + this._lockedTarget.name);
    this._lockedTarget = null;
    this.emit('tactical:targetCleared', {});
  }

  getLockedTarget() { return this._lockedTarget; }

  /**
   * Resolve the locked target entity from a bot's entity list.
   * Returns null if not found or TTL expired.
   *
   * @param {object} bot  — any online mineflayer bot
   * @returns {object|null}
   */
  resolveTarget(bot) {
    const tgt = this._lockedTarget;
    if (!tgt) return null;
    if (Date.now() - tgt.lockedAt > TARGET_TTL_MS * 10) {
      // Very stale lock — clear it
      this.clearTarget();
      return null;
    }
    // Prefer live entity reference
    const live = bot.entities && bot.entities[tgt.entityId];
    if (live && live.position) {
      this.updateTargetPos(live);
      return live;
    }
    return null;
  }

  // ── Coordinated Fleet Engage ──────────────────────────────────────────────

  /**
   * Engage all online bots against the locked target using their assigned
   * formation positions and staggered attack timing.
   *
   * @param {Array<{id, bot}>} botEntries   — all online bots (leader + minions)
   * @param {{x,y,z}}          approachFrom — usually the leader's position
   * @returns {Promise<object>}              result summary
   */
  async engage(botEntries, approachFrom) {
    if (!this._lockedTarget) throw new Error('No target locked — call lockTarget() first');
    if (this._engageActive)  throw new Error('Engage already in progress');

    this._engageActive  = true;
    this._abortSignal   = { aborted: false };

    const tgt         = this._lockedTarget;
    const formation   = this._formation || 'wedge';
    const numBots     = botEntries.filter(e => e.bot && e.bot.entity).length;
    const staggerStep = Math.max(100, Math.floor(STAGGER_BASE_MS / Math.max(numBots, 1)));

    this._addIntel('combat',
      '⚔ Fleet engage — ' + numBots + ' bots | formation: ' + formation +
      ' | target: ' + tgt.name + ' | stagger: ' + staggerStep + 'ms');

    this.emit('tactical:engageStart', {
      formation,
      target: tgt.name,
      bots:   numBots,
      staggerMs: staggerStep
    });

    const promises = botEntries.map((entry) => {
      if (!entry.bot || !entry.bot.entity) return Promise.resolve({ id: entry.id, result: 'offline' });
      const role  = this._roles.get(entry.id) || ROLES.DPS;
      const slot  = this._engageSlots.get(entry.id) || 0;
      const delay = slot * staggerStep;
      return this._engageSingle(entry, role, slot, delay, formation, approachFrom);
    });

    const results = await Promise.allSettled(promises);
    this._engageActive = false;

    const summary = results.map(r =>
      r.status === 'fulfilled' ? r.value : { result: 'error' }
    );

    const killed = summary.filter(s => s.result === 'killed').length;
    this._addIntel('combat', '⚔ Engage complete — ' + killed + '/' + numBots + ' bots scored kills');
    this.emit('tactical:engageEnd', { summary, killed, total: numBots });
    return { summary, killed, total: numBots };
  }

  /**
   * Abort an in-progress coordinated engage.
   */
  abortEngage() {
    this._abortSignal.aborted = true;
    this._engageActive        = false;
    this._addIntel('combat', '🛑 Fleet engage aborted');
    this.emit('tactical:engageAborted', {});
  }

  /**
   * Internal: run a single bot's engage cycle with stagger delay + formation positioning.
   */
  async _engageSingle(entry, role, slot, delayMs, formation, approachFrom) {
    const { id, bot } = entry;
    const signal = this._abortSignal;

    try {
      // ── Stagger: wait this bot's time slice before attacking ───────────────
      if (delayMs > 0) await sleep(delayMs);
      if (signal.aborted || !bot || !bot.entity) return { id, role, result: 'aborted' };

      // ── Resolve live target ────────────────────────────────────────────────
      const target = this.resolveTarget(bot);
      if (!target) return { id, role, result: 'no_target' };

      const targetPos = target.position;
      this.updateTargetPos(target);

      // ── Navigate to formation position ─────────────────────────────────────
      const formPos = formationPosition(formation, slot, targetPos, approachFrom || targetPos);
      await this._moveToFormation(bot, formPos, signal);
      if (signal.aborted || !bot || !bot.entity) return { id, role, result: 'aborted' };

      // ── Role-specific pre-attack behaviour ─────────────────────────────────
      if (role === ROLES.SUPPORT) {
        // Support hangs back and heals/feeds teammates — skip close-range attack
        await this._supportBehaviour(bot, signal);
        return { id, role, result: 'support_cycle' };
      }

      // ── Equip weapon based on role ─────────────────────────────────────────
      await this._equipForRole(bot, role);

      // ── Attack loop — re-resolve target each swing ─────────────────────────
      const deadline  = Date.now() + 20000;
      let   swings    = 0;
      const cooldownMs = this._swingCooldown(bot, role);

      while (Date.now() < deadline && !signal.aborted) {
        if (!bot || !bot.entity) break;

        const live = this.resolveTarget(bot);
        if (!live) return { id, role, result: 'killed', swings };

        const d = bot.entity.position.distanceTo(live.position);

        // ── Close the gap if needed ────────────────────────────────────────
        if (d > ENGAGE_RANGE) {
          try {
            await Promise.race([
              bot.pathfinder.goto(new goals.GoalNear(
                live.position.x, live.position.y, live.position.z, 2
              )),
              sleep(2000)
            ]);
          } catch (_) {}
          continue;
        }

        // ── Look at target ─────────────────────────────────────────────────
        try {
          const eyeH = (live.height || 1.8) * 0.85;
          await bot.lookAt(live.position.offset(0, eyeH, 0), false);
        } catch (_) {}

        // ── Swing ─────────────────────────────────────────────────────────
        try {
          if (bot.pvp && bot.pvp.attack) bot.pvp.attack(live);
          else                           bot.attack(live);
          swings++;
        } catch (_) {}

        // ── Wait for this bot's attack cooldown slot ────────────────────────
        await sleep(cooldownMs);

        this.emit('tactical:swing', { botId: id, role, target: this._lockedTarget && this._lockedTarget.name, swings });
      }

      return { id, role, result: 'timeout', swings };

    } catch (err) {
      this._addIntel('combat', '[' + id + '] engage error: ' + err.message);
      return { id, role, result: 'error', error: err.message };
    }
  }

  // ── Move to formation position ────────────────────────────────────────────

  async _moveToFormation(bot, pos, signal) {
    if (!bot || !bot.entity) return;
    const d = dist2D(bot.entity.position, pos);
    if (d <= 2) return;  // already in position
    try {
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)),
        sleep(5000)
      ]);
    } catch (_) {}
  }

  // ── Role-specific weapon equip ────────────────────────────────────────────

  async _equipForRole(bot, role) {
    const items = bot.inventory ? bot.inventory.items() : [];
    let target  = null;

    if (role === ROLES.TANK || role === ROLES.DPS) {
      for (const tier of Object.keys(SWORD_TIER).sort((a, b) => SWORD_TIER[b] - SWORD_TIER[a])) {
        const found = items.find(it => it.name === tier);
        if (found) { target = found; break; }
      }
    }

    if (target) {
      try { await bot.equip(target, 'hand'); } catch (_) {}
    }
  }

  // ── Per-role attack cooldown ──────────────────────────────────────────────

  _swingCooldown(bot, role) {
    // Tank swings slower but steadier; DPS goes all-out
    const base = Number(process.env.COMBAT_SWORD_COOLDOWN_MS) || STAGGER_BASE_MS;
    if (role === ROLES.TANK) return Math.round(base * 1.15); // 750ms
    if (role === ROLES.DPS)  return Math.round(base * 0.90); // 585ms
    return base;
  }

  // ── Support bot behaviour ─────────────────────────────────────────────────

  async _supportBehaviour(bot, signal) {
    // Support tries to eat and watch from range — can be expanded with healing potions
    if (!bot || !bot.entity) return;
    try {
      if (bot.autoEat && bot.autoEat.eat && bot.food < 18) {
        await bot.autoEat.eat();
      }
    } catch (_) {}
    await sleep(2000);
  }

  // ── Target acquisition: find best hostile mob for fleet ───────────────────

  /**
   * Scan for the nearest hostile entity across all provided bots and lock it.
   * Prefer targets already spotted by multiple bots (higher threat consensus).
   *
   * @param {Array<{id, bot}>} botEntries
   * @param {number}           range  — scan radius
   * @returns {object|null}   locked target or null
   */
  acquireTarget(botEntries, range = 16) {
    const HOSTILE_MOBS = require('./combat').HOSTILE_MOBS;
    const candidates   = new Map();  // entity.id → { entity, votes, nearestDist }

    for (const entry of botEntries) {
      const bot = entry.bot;
      if (!bot || !bot.entity) continue;

      const mob = bot.nearestEntity(e =>
        e.type === 'mob' &&
        HOSTILE_MOBS.includes(e.name) &&
        e.position &&
        bot.entity.position.distanceTo(e.position) <= range
      );

      if (!mob) continue;

      const existing = candidates.get(mob.id);
      const d        = bot.entity.position.distanceTo(mob.position);
      if (existing) {
        existing.votes++;
        if (d < existing.nearestDist) existing.nearestDist = d;
      } else {
        candidates.set(mob.id, { entity: mob, votes: 1, nearestDist: d });
      }
    }

    if (!candidates.size) return null;

    // Pick entity with most votes, tie-break by distance
    const sorted = Array.from(candidates.values())
      .sort((a, b) => b.votes - a.votes || a.nearestDist - b.nearestDist);

    const chosen = sorted[0];
    const firstBot = botEntries.find(e => e.bot && e.bot.entity);
    if (!firstBot) return null;

    return this.lockTarget(firstBot.id, chosen.entity);
  }

  // ── Status API ────────────────────────────────────────────────────────────

  getStatus() {
    return {
      formation:    this._formation,
      lockedTarget: this._lockedTarget,
      roles:        this.getRolesSnapshot(),
      engageActive: this._engageActive,
      intelFeed:    this._intelLog.slice(-20)
    };
  }

  getIntelFeed(n = 40) {
    return this._intelLog.slice(-n);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  _addIntel(type, message) {
    const entry = { type, message, at: new Date().toISOString() };
    this._intelLog.push(entry);
    if (this._intelLog.length > this._maxIntel) this._intelLog.shift();
    this.emit('tactical:intel', entry);

    // Also forward into HiveMind intel feed
    try {
      const hiveMind = require('../core/hiveMind');
      hiveMind._addIntel('combat', message);
    } catch (_) {}
  }
}

module.exports = new TacticalEngine();
