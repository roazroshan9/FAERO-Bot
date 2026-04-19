const { goals, Movements } = require('mineflayer-pathfinder');
const Vec3 = require('vec3').Vec3;

function setupMovements(bot) {
  if (!bot.pathfinder || !bot.registry) return null;

  const movements = new Movements(bot);

  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  movements.allowSprinting = true;

  // Avoid lava and fire — treat as impassable
  const danger = ['lava', 'flowing_lava', 'fire', 'magma_block'];
  danger.forEach((name) => {
    const block = bot.registry.blocksByName[name];
    if (block) movements.blocksCantBreak.add(block.id);
  });

  bot.pathfinder.setMovements(movements);
  return movements;
}

// ✅ SAFE GO TO (no crash)
async function goToCoords(bot, x, y, z, range) {
  setupMovements(bot);

  const nx = Number(x);
  const ny = Number(y);
  const nz = Number(z);

  if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
    bot.chat("Invalid coordinates!");
    return;
  }

  const goal = new goals.GoalNear(nx, ny, nz, range || 1);

  try {
    await bot.pathfinder.goto(goal);
  } catch (err) {
    const msg = err && err.message ? err.message.toLowerCase() : '';
    if (msg.includes('no path') || msg.includes('cannot find')) {
      throw new Error('no path found to ' + nx + ' ' + ny + ' ' + nz);
    }
    throw err;
  }
}

// ✅ SAFE FOLLOW
function followPlayer(bot, username, distance) {
  setupMovements(bot);

  const target = bot.players[username]?.entity;

  if (!target) {
    bot.chat("I can't see you!");
    return;
  }

  const dist = bot.entity.position.distanceTo(target.position);

  if (dist > 50) {
    bot.chat("Too far! Come closer.");
    return;
  }

  bot.pathfinder.setGoal(
    new goals.GoalFollow(target, distance || 2),
    true
  );
}

// ✅ SAFE STOP
function stop(bot) {
  if (bot.pathfinder) {
    bot.pathfinder.setGoal(null);
    bot.pathfinder.stop();
  }

  bot.clearControlStates();
}

// ✅ OPTIMIZED BLOCK SEARCH
function nearestBlock(bot, names, maxDistance) {
  if (!bot || !bot.registry || !bot.registry.blocksByName) return null;

  const ids = names
    .map((name) => bot.registry.blocksByName[name])
    .filter(Boolean)
    .map((block) => block.id);

  if (!ids.length) return null;

  return bot.findBlock({
    matching: ids,
    maxDistance: Math.min(Number(maxDistance) || 24, 24), // limit
    count: 1
  });
}

// ✅ LIGHTWEIGHT AREA POSITIONS (avoid memory crash)
function positionsAround(center, radius) {
  const list = [];

  const r = Math.min(Number(radius) || 3, 4); // limit radius
  const base = new Vec3(
    Math.floor(center.x),
    Math.floor(center.y),
    Math.floor(center.z)
  );

  for (let y = base.y; y >= base.y - r; y--) {
    for (let x = base.x - r; x <= base.x + r; x++) {
      for (let z = base.z - r; z <= base.z + r; z++) {
        list.push(new Vec3(x, y, z));
      }
    }
  }

  return list;
}

module.exports = {
  setupMovements,
  goToCoords,
  followPlayer,
  stop,
  nearestBlock,
  positionsAround
};