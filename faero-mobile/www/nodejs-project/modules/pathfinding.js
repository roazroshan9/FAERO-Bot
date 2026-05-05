const { goals, Movements } = require('mineflayer-pathfinder');
const Vec3 = require('vec3').Vec3;

// Hard timeout for the entire goToCoords operation (ms). Prevents the bot
// from getting stuck forever on impossible / repeatedly-failing paths.
const HARD_PATH_TIMEOUT_MS = 30000;

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

  // Bound pathfinder CPU so it can never stall the event loop
  bot.pathfinder.thinkTimeout = 5000;  // max ms thinking per call
  bot.pathfinder.tickTimeout  = 40;    // max ms thinking per tick

  return movements;
}

// ✅ SAFE GO TO — single attempt, hard wall-clock timeout, clean error.
//    Never loops. Never blocks. Always cancellable via bot.pathfinder.stop().
async function goToCoords(bot, x, y, z, range) {
  setupMovements(bot);

  const nx = Number(x);
  const ny = Number(y);
  const nz = Number(z);

  if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
    throw new Error('Pathfinding failed — invalid coordinates ' + x + ' ' + y + ' ' + z);
  }

  const goal = new goals.GoalNear(nx, ny, nz, range || 1);

  // Wrap pathfinder.goto with a hard timeout so we can't get stuck.
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      try { bot.pathfinder.setGoal(null); bot.pathfinder.stop(); } catch (_) {}
      reject(new Error('Pathfinding failed — wall-clock timeout (' + HARD_PATH_TIMEOUT_MS + 'ms) reached'));
    }, HARD_PATH_TIMEOUT_MS);
  });

  try {
    await Promise.race([bot.pathfinder.goto(goal), timeoutPromise]);
  } catch (err) {
    const msg = err && err.message ? err.message.toLowerCase() : '';
    // Always reset pathfinder state so the next call starts clean
    try { bot.pathfinder.setGoal(null); } catch (_) {}
    if (msg.includes('no path') || msg.includes('cannot find') || msg.includes('timeout') || msg.includes('took to long')) {
      throw new Error('Pathfinding failed — no safe route to ' + nx + ' ' + ny + ' ' + nz);
    }
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
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