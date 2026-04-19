const survival = require('./survival');
const combat = require('./combat');
const pathfinding = require('./pathfinding');
const economy = require('./economy');
const { STATES } = require('../core/stateManager');

function normalize(message) {
  return String(message || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isAuthorized(username, memory) {
  const configured = process.env.AUTHORIZED_USER || 'roaz';
  return username === configured || memory.isTrusted(username);
}

// ✅ safe player finder
function getTarget(bot, username) {
  const target = bot.players[username]?.entity;

  if (!target) {
    bot.chat("I can't see you!");
    return null;
  }

  const distance = bot.entity.position.distanceTo(target.position);

  if (distance > 50) {
    bot.chat("Too far! Come closer.");
    return null;
  }

  return target;
}

function handleChat(ctx, username, message) {
  if (username === ctx.bot.username) return false;
  if (!isAuthorized(username, ctx.memory)) return false;
  return handleCommand(ctx, username, message);
}

function handleCommand(ctx, username, message) {
  const text = normalize(message);
  if (!text) return false;

  const bot = ctx.bot;
  if (!bot || !bot.entity) return false;

  const queue = ctx.taskQueue;
  const state = ctx.stateManager;
  const memory = ctx.memory;
  const pvpEnabled = ctx.pvpEnabled;

  function commandTask(name, fn) {
    if (ctx.manager && ctx.manager.tryCommandCooldown) {
      if (!ctx.manager.tryCommandCooldown()) {
        bot.chat('Please wait before sending another command.');
        return false;
      }
    }
    if (ctx.manager && ctx.manager.commandInterrupt) {
      ctx.manager.commandInterrupt();
    }
    queue.clear();
    queue.push(name, async () => {
      state.setState(STATES.COMMAND, name);
      memory.setLastAction('command: ' + name);
      try {
        await fn();
      } catch (err) {
        console.log('Command error:', err.message);
        bot.chat("Something went wrong.");
      } finally {
        state.reset('command complete');
      }
    }, { priority: 100 });
    return true;
  }

  // -----------------
  // 🟢 MOVEMENT
  // -----------------

  if (text === 'follow me') {
    return commandTask('follow', async () => {
      const target = getTarget(bot, username);
      if (!target) return;

      bot.chat("Following you...");
      state.setState(STATES.FOLLOWING, username);
      pathfinding.followPlayer(bot, username, 2);
    });
  }

  if (text === 'come here') {
    return commandTask('come here', async () => {
      const target = getTarget(bot, username);
      if (!target) return;

      bot.chat("Coming...");
      await pathfinding.goToCoords(
        bot,
        target.position.x,
        target.position.y,
        target.position.z,
        1
      );
    });
  }

  if (text === 'stop') {
    return commandTask('stop', async () => {
      bot.chat("Stopping...");
      pathfinding.stop(bot);
      combat.stopCombat(bot);
    });
  }

  // -----------------
  // 📍 GO TO
  // -----------------

  let match = text.match(/^go to (-?\d+) (-?\d+) (-?\d+)$/);
  if (match) {
    return commandTask('go to', async () => {
      bot.chat("Moving...");
      await pathfinding.goToCoords(
        bot,
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        1
      );
    });
  }

  // -----------------
  // ⚔️ COMBAT
  // -----------------

  match = text.match(/^attack ([a-zA-Z0-9_]+)$/);
  if (match) {
    const target = match[1];
    return commandTask('attack', async () => {
      bot.chat("Attacking " + target);
      state.setState(STATES.FIGHTING, target);
      memory.addEnemy(target);
      await combat.attackPlayer(bot, memory, target, pvpEnabled);
    });
  }

  if (text === 'defend me') {
    return commandTask('defend', async () => {
      bot.chat("Defending...");
      memory.trustPlayer(username);

      const hostile = combat.nearestHostileMob(bot, 24);

      if (hostile) {
        bot.chat("Enemy found!");
        state.setState(STATES.FIGHTING, hostile.name);
        await combat.attackMob(bot, hostile);
      } else {
        bot.chat("No enemies nearby.");
      }
    });
  }

  // -----------------
  // 🌾 SURVIVAL
  // -----------------

  if (text === 'collect food') {
    return commandTask('food', async () => {
      bot.chat("Collecting food...");
      await survival.collectFood(bot);
    });
  }

  if (text === 'eat food') {
    return commandTask('eat', async () => {
      bot.chat("Eating...");
      await survival.eatFood(bot);
    });
  }

  // -----------------
  // ⛏️ MINING
  // -----------------

  if (text === 'mine iron') {
    return commandTask('mine iron', async () => {
      bot.chat("Mining iron...");
      state.setState(STATES.MINING, 'iron');
      await survival.mineIron(bot);
    });
  }

  if (text === 'cut wood') {
    return commandTask('wood', async () => {
      bot.chat("Cutting trees...");
      state.setState(STATES.MINING, 'wood');
      await survival.cutWood(bot);
    });
  }

  match = text.match(/^mine (-?\d+) (-?\d+) (-?\d+)(?: radius (\d+))?$/);
  if (match) {
    return commandTask('area mine', async () => {
      bot.chat("Area mining...");
      state.setState(STATES.MINING, 'area');
      await survival.mineArea(
        bot,
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        Number(match[4] || 5)
      );
    });
  }

  match = text.match(/^mine ([a-z0-9_]+)$/);
  if (match) {
    const blockName = match[1];
    return commandTask('mine block', async () => {
      bot.chat("Mining " + blockName);
      state.setState(STATES.MINING, blockName);
      await survival.mineBlockByName(bot, blockName, 64);
    });
  }

  // -----------------
  // 💸 ECONOMY
  // -----------------

  match = text.match(/^pay ([a-zA-Z0-9_]+) (\d+)$/);
  if (match) {
    return commandTask('pay', async () => {
      bot.chat("Paying...");
      state.setState(STATES.PAYING, match[1]);
      await economy.pay(
        bot,
        memory,
        match[1],
        Number(match[2]),
        'manual',
        10000
      );
    });
  }

  if (text === 'bal' || text === 'balance') {
    return commandTask('balance', async () => {
      economy.requestBalance(bot);
    });
  }

  // -----------------
  // 🧠 EXTRA COMMANDS
  // -----------------

  if (text === 'status') {
    return commandTask('status', async () => {
      bot.chat(`HP: ${bot.health} | Hunger: ${bot.food}`);
    });
  }

  if (text === 'jump') {
    return commandTask('jump', async () => {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 400);
    });
  }

  if (text === 'look around') {
    return commandTask('look', async () => {
      bot.look(Math.random() * Math.PI * 2, 0, true);
    });
  }

  return false;
}

module.exports = {
  handleChat,
  handleCommand,
  isAuthorized
};