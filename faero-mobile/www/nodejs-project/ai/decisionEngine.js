const survival  = require('../modules/survival');
const combat    = require('../modules/combat');
const combatAI  = require('../modules/combatAI');
const economy   = require('../modules/economy');
const inventory = require('../modules/inventory');
const { STATES } = require('../core/stateManager');

const DEFAULTS = {
  mobScanIntervalMs: 15000,
  oreScanIntervalMs: 120000,
  survivalActionIntervalMs: 45000,
  dangerActionIntervalMs: 20000,
  resourceActionIntervalMs: 120000,
  economyActionIntervalMs: 600000,
  maxEntityScan: 80,
  maxNearbyPlayers: 8,
  maxNearbyMobs: 12,
  oreScanDistance: 24
};
const CPU_LIMIT_PERCENT = Number(process.env.AI_CPU_LIMIT_PERCENT || 30);

function think(bot) {
  const throttle = getThrottle(bot);
  const now = Date.now();
  const nearbyPlayers = Object.keys(bot.players || {})
    .filter((name) => name !== bot.username)
    .slice(0, DEFAULTS.maxNearbyPlayers)
    .map((name) => {
      const player = bot.players[name];
      return {
        username: name,
        distance: player && player.entity ? bot.entity.position.distanceTo(player.entity.position) : null
      };
    });

  let nearbyMobs = throttle.cachedNearbyMobs || [];
  let hostileMob = throttle.cachedHostileMob || null;

  // Evict stale entity references — entity may have despawned since last scan
  if (hostileMob && !bot.entities[hostileMob.id]) {
    throttle.cachedHostileMob = null;
    hostileMob = null;
  }

  if (now - (throttle.lastMobScan || 0) >= readMs('MOB_SCAN_INTERVAL_MS', DEFAULTS.mobScanIntervalMs)) {
    const scan = scanNearbyMobs(bot);
    nearbyMobs = scan.nearbyMobs;
    // Store only the entity id + name, not the full object, to avoid holding GC roots
    hostileMob = scan.hostileMob
      ? { id: scan.hostileMob.id, name: scan.hostileMob.name, type: scan.hostileMob.type, position: scan.hostileMob.position }
      : null;
    throttle.cachedNearbyMobs = nearbyMobs;
    throttle.cachedHostileMob = hostileMob;
    throttle.lastMobScan = now;
  }

  const inventorySummary = inventory.getInventorySummary(bot);
  const foodStock = inventory.countItem(bot, survival.FOOD_ITEMS);

  return {
    health: bot.health,
    hunger: bot.food,
    position: bot.entity && bot.entity.position ? bot.entity.position : null,
    inventory: inventorySummary,
    foodStock,
    nearbyPlayers,
    nearbyMobs,
    hostileMob
  };
}

function decide(ctx, snapshot) {
  const throttle = getContextThrottle(ctx);
  const now = Date.now();
  if (!ctx.bot || !ctx.bot.entity) return { type: 'idle', reason: 'not_spawned' };
  if (ctx.stateManager.getState().state === STATES.COMMAND) return { type: 'idle', reason: 'command_override' };
  if (ctx.taskQueue.running || ctx.taskQueue.queue.length > 0) return { type: 'idle', reason: 'queue_busy' };
  if (isCpuBusy(throttle, now)) return { type: 'idle', reason: 'cpu_throttle' };
  if (snapshot.health <= 8 && cooldownReady(throttle, 'survival', readMs('SURVIVAL_ACTION_INTERVAL_MS', DEFAULTS.survivalActionIntervalMs), now)) {
    return { type: 'survival', reason: 'low_health' };
  }
  if (snapshot.hunger !== undefined && snapshot.hunger <= 14 && cooldownReady(throttle, 'survival', readMs('SURVIVAL_ACTION_INTERVAL_MS', DEFAULTS.survivalActionIntervalMs), now)) {
    return { type: 'survival', reason: 'hungry' };
  }
  if (snapshot.hostileMob && cooldownReady(throttle, 'danger', readMs('DANGER_ACTION_INTERVAL_MS', DEFAULTS.dangerActionIntervalMs), now)) {
    return { type: 'danger', reason: snapshot.hostileMob.name, target: snapshot.hostileMob };
  }
  const enemy = snapshot.nearbyPlayers.find((player) => ctx.memory.isEnemy(player.username));
  if (enemy && ctx.pvpEnabled && cooldownReady(throttle, 'danger', readMs('DANGER_ACTION_INTERVAL_MS', DEFAULTS.dangerActionIntervalMs), now)) {
    return { type: 'combat', reason: enemy.username };
  }
  if (snapshot.foodStock < 8 && cooldownReady(throttle, 'resource', readMs('RESOURCE_ACTION_INTERVAL_MS', DEFAULTS.resourceActionIntervalMs), now)) {
    return { type: 'resource', reason: 'food_stock_low' };
  }
  const oreScanInterval = readMs('ORE_SCAN_INTERVAL_MS', DEFAULTS.oreScanIntervalMs);
  if (now - (ctx.lastOreScan || 0) > oreScanInterval && cooldownReady(throttle, 'resource', readMs('RESOURCE_ACTION_INTERVAL_MS', DEFAULTS.resourceActionIntervalMs), now)) {
    const ore = survival.findPriorityOre(ctx.bot, readMs('ORE_SCAN_DISTANCE', DEFAULTS.oreScanDistance));
    ctx.lastOreScan = now;
    if (ctx.manager) ctx.manager.lastOreScan = ctx.lastOreScan;
    if (ore) return { type: 'resource', reason: 'ore_found', ore };
  }
  if (now - ctx.lastEconomyCheck > readMs('ECONOMY_ACTION_INTERVAL_MS', DEFAULTS.economyActionIntervalMs)) return { type: 'economy', reason: 'balance_check' };
  return { type: 'idle', reason: 'exploring' };
}

async function act(ctx, decision) {
  const bot = ctx.bot;
  if (!bot || !bot.entity || !decision) return;

  if (decision.type === 'idle') {
    ctx.stateManager.setState(STATES.IDLE, decision.reason);
    if (ctx.manager) ctx.manager.log('AI state: ' + decision.reason);
    return;
  }

  if (decision.type === 'survival') {
    markCooldown(ctx, 'survival');
    ctx.taskQueue.push('survival: ' + decision.reason, async () => {
      ctx.stateManager.setState(STATES.ESCAPING, decision.reason);
      await survival.survivalTick(bot);
      await survival.collectFood(bot);
      ctx.memory.setLastAction('survival ' + decision.reason);
      if (ctx.manager) ctx.manager.log('AI survival action: ' + decision.reason);
      ctx.stateManager.reset('survival_complete');
    }, { priority: 90 });
    return;
  }

  if (decision.type === 'danger') {
    markCooldown(ctx, 'danger');
    const cachedTargetId = decision.target && decision.target.id;
    ctx.taskQueue.push('danger: ' + decision.reason, async () => {
      ctx.stateManager.setState(STATES.FIGHTING, decision.reason);
      if (ctx.manager) ctx.manager._lastCombatTarget = decision.reason;
      // Re-fetch live entity at execution time — avoids holding stale GC root across queue delay
      const liveEntity = cachedTargetId ? bot.entities[cachedTargetId] : null;
      if (!liveEntity) {
        // Entity already gone — fall back to name scan
        const found = bot.nearestEntity(e => e.name === decision.reason && e.type === 'mob');
        if (found) await combatAI.engageMob(bot, found, {});
      } else {
        const result = await combatAI.engageMob(bot, liveEntity, {});
        if (ctx.manager) ctx.manager.log(
          '[combatAI] ' + decision.reason + ' → ' + result.result +
          (result.looted ? ' (drops collected)' : '')
        );
      }
      ctx.memory.setLastAction('fought mob ' + decision.reason);
      ctx.stateManager.reset('danger_handled');
    }, { priority: 80 });
    return;
  }

  if (decision.type === 'combat') {
    markCooldown(ctx, 'danger');
    ctx.taskQueue.push('combat: ' + decision.reason, async () => {
      ctx.stateManager.setState(STATES.FIGHTING, decision.reason);
      await combat.attackPlayer(bot, ctx.memory, decision.reason, ctx.pvpEnabled);
      ctx.memory.setLastAction('fought enemy ' + decision.reason);
      if (ctx.manager) ctx.manager.log('AI player combat action: ' + decision.reason);
      ctx.stateManager.reset('combat_complete');
    }, { priority: 70 });
    return;
  }

  if (decision.type === 'resource') {
    markCooldown(ctx, 'resource');
    ctx.taskQueue.push('resource: ' + decision.reason, async () => {
      ctx.stateManager.setState(STATES.MINING, decision.reason);
      if (decision.ore) {
        await survival.mineBlockObject(bot, decision.ore);
      } else {
        await survival.collectFood(bot);
        await survival.collectNearbyResources(bot);
      }
      ctx.memory.setLastAction('resource ' + decision.reason);
      if (ctx.manager) ctx.manager.log('AI resource action: ' + decision.reason);
      ctx.stateManager.reset('resource_complete');
    }, { priority: 40 });
    return;
  }

  if (decision.type === 'economy') {
    markCooldown(ctx, 'economy');
    ctx.taskQueue.push('economy: ' + decision.reason, async () => {
      ctx.stateManager.setState(STATES.PAYING, decision.reason);
      economy.requestBalance(bot);
      ctx.lastEconomyCheck = Date.now();
      if (ctx.manager) {
        ctx.manager.lastEconomyCheck = ctx.lastEconomyCheck;
        ctx.manager.log('AI economy action: ' + decision.reason);
      }
      ctx.memory.setLastAction('checked balance');
      ctx.stateManager.reset('economy_complete');
    }, { priority: 10 });
  }
}

function scanNearbyMobs(bot) {
  const nearbyMobs = [];
  let hostileMob = null;
  const entities = Object.values(bot.entities || {}).slice(0, readMs('MAX_ENTITY_SCAN', DEFAULTS.maxEntityScan));
  for (const entity of entities) {
    if (!entity || entity.type !== 'mob' || !entity.position || !bot.entity || !bot.entity.position) continue;
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 24) continue;
    if (nearbyMobs.length < DEFAULTS.maxNearbyMobs) {
      nearbyMobs.push({ name: entity.name, distance });
    }
    if (!hostileMob && distance <= 16 && combat.isHostileMob(entity)) {
      hostileMob = entity;
    }
  }
  return { nearbyMobs, hostileMob };
}

function getThrottle(bot) {
  if (!bot._aiThrottle) {
    bot._aiThrottle = {
      lastMobScan: 0,
      cachedNearbyMobs: [],
      cachedHostileMob: null,
      cooldowns: {}
    };
  }
  return bot._aiThrottle;
}

function getContextThrottle(ctx) {
  if (ctx.manager) {
    if (!ctx.manager.aiThrottle) ctx.manager.aiThrottle = { cooldowns: {} };
    if (!ctx.manager.aiThrottle.cooldowns) ctx.manager.aiThrottle.cooldowns = {};
    if (!ctx.manager.aiThrottle.cpuUsage) {
      ctx.manager.aiThrottle.cpuUsage = process.cpuUsage();
      ctx.manager.aiThrottle.cpuCheckedAt = Date.now();
      ctx.manager.aiThrottle.cpuPercent = 0;
    }
    return ctx.manager.aiThrottle;
  }
  return getThrottle(ctx.bot);
}

function cooldownReady(throttle, key, delayMs, now) {
  const cooldowns = throttle.cooldowns || {};
  return now - (cooldowns[key] || 0) >= delayMs;
}

function markCooldown(ctx, key) {
  const throttle = getContextThrottle(ctx);
  if (!throttle.cooldowns) throttle.cooldowns = {};
  throttle.cooldowns[key] = Date.now();
}

function readMs(name, fallback) {
  const number = Number(process.env[name]);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isCpuBusy(throttle, now) {
  if (!Number.isFinite(CPU_LIMIT_PERCENT) || CPU_LIMIT_PERCENT <= 0) return false;
  if (now - (throttle.cpuCheckedAt || 0) < 5000) {
    return (throttle.cpuPercent || 0) >= CPU_LIMIT_PERCENT;
  }
  const previous = throttle.cpuUsage || process.cpuUsage();
  const current = process.cpuUsage(previous);
  const elapsedMs = Math.max(1, now - (throttle.cpuCheckedAt || now));
  throttle.cpuUsage = process.cpuUsage();
  throttle.cpuCheckedAt = now;
  throttle.cpuPercent = Math.min(100, Math.max(0, ((current.user + current.system) / 1000 / elapsedMs) * 100));
  return throttle.cpuPercent >= CPU_LIMIT_PERCENT;
}

module.exports = { act, think, decide };
