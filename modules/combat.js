const HOSTILE_MOBS = [
  'zombie',
  'skeleton',
  'creeper',
  'spider',
  'cave_spider',
  'witch',
  'enderman',
  'slime',
  'drowned',
  'husk',
  'stray',
  'pillager',
  'vindicator',
  'evoker',
  'ravager',
  'guardian',
  'elder_guardian',
  'phantom',
  'blaze',
  'ghast',
  'magma_cube',
  'piglin_brute',
  'wither_skeleton',
  'zoglin'
];

function isHostileMob(entity) {
  return Boolean(entity && entity.name && HOSTILE_MOBS.includes(entity.name));
}

function nearestHostileMob(bot, range) {
  return bot.nearestEntity((entity) => {
    return entity.type === 'mob' && isHostileMob(entity) && bot.entity.position.distanceTo(entity.position) <= (range || 16);
  });
}

function canAttackPlayer(bot, memory, username, pvpEnabled) {
  if (!username || username === bot.username) return false;
  if (memory.isTrusted(username)) return false;
  if (!pvpEnabled) return false;
  if (memory.isEnemy(username)) return true;
  return memory.recentlyAttackedBy(username, 120000);
}

async function attackEntity(bot, entity) {
  if (!entity) throw new Error('No target entity');
  if (bot.pvp && bot.pvp.attack) {
    bot.pvp.attack(entity);
    await wait(5000);
    return;
  }
  bot.attack(entity);
}

async function attackMob(bot, nameOrEntity) {
  const entity = typeof nameOrEntity === 'string'
    ? bot.nearestEntity((target) => target.name === nameOrEntity)
    : nameOrEntity;
  if (!entity) throw new Error('Mob not found');
  await attackEntity(bot, entity);
}

async function attackPlayer(bot, memory, username, pvpEnabled) {
  if (!canAttackPlayer(bot, memory, username, pvpEnabled)) {
    throw new Error('Safety blocked player attack: ' + username);
  }
  const target = bot.players[username]?.entity;

if (!target) {
  bot.chat("I can't see you!");
  return;
}

const distance = bot.entity.position.distanceTo(target.position);

if (distance > 50) {
  bot.chat("Too far! Come closer.");
  return;
}
  await attackEntity(bot, target);
}

function stopCombat(bot) {
  if (bot.pvp && bot.pvp.stop) {
    bot.pvp.stop();
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  HOSTILE_MOBS,
  isHostileMob,
  nearestHostileMob,
  canAttackPlayer,
  attackEntity,
  attackMob,
  attackPlayer,
  stopCombat
};