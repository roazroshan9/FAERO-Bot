const EventEmitter = require('events');
const mineflayer = require('mineflayer');
const pathfinderPlugin = require('mineflayer-pathfinder').pathfinder;
const collectBlockPlugin = require('mineflayer-collectblock').plugin;
const pvpPlugin = require('mineflayer-pvp').plugin;
const armorManagerPlugin = require('mineflayer-armor-manager');
const autoEatPlugin = require('mineflayer-auto-eat').loader;
const toolPlugin = require('mineflayer-tool').plugin;
const TaskQueue = require('./taskQueue');
const Memory = require('./memory');
const { StateManager, STATES } = require('./stateManager');
const Brain = require('../ai/brain');
const survival = require('../modules/survival');
const commands = require('../modules/commands');
const combat = require('../modules/combat');

class BotManager extends EventEmitter {
  constructor() {
    super();
    this.bot = null;
    this.brain = null;
    this.reconnectTimer = null;
    this.shouldReconnect = true;
    this.reconnectDelay = 5000;
    this.logs = [];
    this.lastConnectionOptions = null;
    this.lastEconomyCheck = 0;
    this.lastOreScan = 0;
    this.taskQueue = new TaskQueue({ timeoutMs: 180000 });
    this.memory = new Memory();
    this.stateManager = new StateManager();
    this.pvpEnabled = String(process.env.PVP_ENABLED || '').toLowerCase() === 'true';
    this.lowPowerMode = false;
    this.aiModeEnabled = false;
    this.cleanupTimer = null;
    this._dangerWatchTimer = null;
    this.lastCommandAt = 0;
    this.commandCooldownMs = readPositiveInt(process.env.COMMAND_COOLDOWN_MS, 2000);
    this.bindCoreEvents();
  }

  bindCoreEvents() {
    this.taskQueue.on('taskError', (payload) => this.log('Task error: ' + payload.task + ' - ' + payload.error));
    this.taskQueue.on('started', (snapshot) => this.emit('queue', snapshot));
    this.taskQueue.on('idle', (snapshot) => this.emit('queue', snapshot));
    this.stateManager.on('change', (state) => this.emit('state', state));
  }

  createBot(options) {
    const config = buildBotConfig(options);

    this.lastConnectionOptions = Object.assign({}, config);
    this.shouldReconnect = true;
    this.stopBotOnly();
    this.log('Creating bot for ' + config.host + ':' + config.port + ' as ' + config.username);

    const bot = mineflayer.createBot(config);
    this.bot = bot;
    this.loadPlugins(bot);
    this.bindBotEvents(bot);
    return bot;
  }

  loadPlugins(bot) {
    bot.loadPlugin(pathfinderPlugin);
    bot.loadPlugin(collectBlockPlugin);
    bot.loadPlugin(pvpPlugin);
    bot.loadPlugin(armorManagerPlugin);
    bot.loadPlugin(autoEatPlugin);
    bot.loadPlugin(toolPlugin);
  }

  bindBotEvents(bot) {
    bot.once('spawn', async () => {
      this.log('Spawned in world');
      await survival.configure(bot);
      this.stateManager.reset('spawned');
      this.startBrain();
      this.startDangerWatch(bot);
      this.attachInventoryEvents(bot);
      this.emit('bot', this.getStatus());
      this.emit('inventory', this.getInventory());
    });

    bot.on('chat', (username, message) => {
      this.log('<' + username + '> ' + message);
      try {
        commands.handleChat(this.getContext(), username, message);
      } catch (err) {
        this.log('Command error: ' + err.message);
      }
    });

    bot.on('entityHurt', (entity) => {
      if (!bot.entity || entity.id !== bot.entity.id) return;
      const attacker = nearestPlayerName(bot, 6);
      if (attacker && !this.memory.isTrusted(attacker)) {
        this.memory.markAttackedBy(attacker);
        this.log('Marked recent attacker: ' + attacker);
      }
      this._onDangerDetected('took_damage');
    });

    bot.on('health', () => {
      this.emit('bot', this.getStatus());
    });

    bot.on('death', () => {
      this.log('Bot died');
      combat.stopCombat(bot);
      this.taskQueue.clear();
      this.stateManager.reset('death');
    });

    bot.on('kicked', (reason) => {
      this.log('Kicked: ' + reason);
    });

    bot.on('error', (err) => {
      this.log('Bot error: ' + (err && err.message ? err.message : String(err)));
      this.emit('botError', err);
    });

    bot.on('end', (reason) => {
      this.log('Disconnected: ' + (reason || 'connection ended'));
      this._stopDangerWatch();
      this.stopBrain();
      this.bot = null;
      this.emit('bot', this.getStatus());
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });
  }

  startBrain() {
    this.stopBrain();
    if (!this.aiModeEnabled) return;
    this.brain = new Brain(this.getContext());
    this.brain.on('thought', (payload) => {
      this.emit('thought', payload);
      this.emit('bot', this.getStatus());
    });
    this.brain.on('error', (err) => this.log('Brain error: ' + err.message));
    this.brain.start();
    if (this.lowPowerMode) this.brain.setTickMs(30000);
  }

  setAiMode(enabled) {
    this.aiModeEnabled = Boolean(enabled);
    if (this.aiModeEnabled) {
      if (!this.lowPowerMode) this.setLowPowerMode(true);
      if (this.bot && this.bot.entity && !this.brain) this.startBrain();
    } else {
      this.stopBrain();
      this.taskQueue.clear();
      this.stateManager.reset('ai_mode_off');
    }
    this.log('AI mode: ' + (this.aiModeEnabled ? 'ON' : 'OFF'));
    this.emit('bot', this.getStatus());
  }

  tryCommandCooldown() {
    const now = Date.now();
    if (now - this.lastCommandAt < this.commandCooldownMs) return false;
    this.lastCommandAt = now;
    return true;
  }

  commandInterrupt() {
    if (this.brain) this.brain.interrupt();
    const bot = this.bot;
    if (bot && bot.pathfinder) {
      try { bot.pathfinder.stop(); } catch (err) { /* ignore */ }
    }
  }

  startDangerWatch(bot) {
    this._stopDangerWatch();
    const DANGER_RANGE = readPositiveInt(process.env.DANGER_WATCH_RANGE, 5);
    const POLL_MS = 2000;
    this._dangerWatchTimer = setInterval(() => {
      if (!bot.entity) return;
      const mob = combat.nearestHostileMob(bot, DANGER_RANGE);
      if (mob) this._onDangerDetected('mob_nearby:' + mob.name);
    }, POLL_MS);
  }

  _stopDangerWatch() {
    if (this._dangerWatchTimer) {
      clearInterval(this._dangerWatchTimer);
      this._dangerWatchTimer = null;
    }
  }

  _onDangerDetected(reason) {
    if (!this.brain || !this.bot || !this.bot.entity) return;
    const state = this.stateManager.getState().state;
    if (state === STATES.FIGHTING || state === STATES.COMMAND) return;
    this.log('[danger] Emergency wake: ' + reason);
    if (this.bot._aiThrottle) this.bot._aiThrottle.lastMobScan = 0;
    this.brain.interrupt();
    this.brain.triggerTick();
  }

  setLowPowerMode(enabled) {
    this.lowPowerMode = Boolean(enabled);
    if (this.brain) {
      this.brain.setTickMs(this.lowPowerMode ? 30000 : 10000);
    }
    this.log('Low power mode: ' + (this.lowPowerMode ? 'ON' : 'OFF'));
    this.emit('bot', this.getStatus());
  }

  attachInventoryEvents(bot) {
    if (bot._webInventoryBridgeAttached) return;
    bot._webInventoryBridgeAttached = true;
    bot.inventory.on('updateSlot', () => {
      this.emit('inventory', this.getInventory());
    });
  }

  getInventory() {
    const bot = this.bot;
    if (!bot || !bot.inventory) return { ok: false, slots: [] };
    const slots = [];
    for (let i = 0; i <= 45; i++) {
      const item = bot.inventory.slots[i];
      if (item) {
        slots.push({
          slot: i,
          name: item.name,
          displayName: item.displayName || item.name,
          count: item.count,
          stackSize: item.stackSize || 64
        });
      }
    }
    return { ok: true, slots };
  }

  startAutoCleanup() {
    if (this.cleanupTimer) return;
    const intervalMs = Number(process.env.AUTO_CLEANUP_INTERVAL_MS) || 300000;
    this.cleanupTimer = setInterval(() => this._runCleanup(), intervalMs);
  }

  _runCleanup() {
    if (this.logs.length > 100) this.logs.splice(0, this.logs.length - 100);
    const changed = this.memory.cleanup(true);
    if (changed) this.memory.save();
    this.log('[cleanup] memory and cache trimmed');
  }

  stopBrain() {
    if (this.brain) {
      this.brain.stop();
      this.brain = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.log('Reconnect scheduled in ' + this.reconnectDelay + 'ms');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.createBot(this.lastConnectionOptions || undefined);
      }
    }, this.reconnectDelay);
  }

  stopBotOnly() {
    this._stopDangerWatch();
    if (this.bot) {
      try {
        this.bot.removeAllListeners('end');
        this.bot.quit('restart');
      } catch (err) {
        try {
          this.bot.end();
        } catch (inner) {
          return;
        }
      }
      this.bot = null;
    }
    this.stopBrain();
  }

  stop() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.taskQueue.clear();
    this.stopBotOnly();
    this.stateManager.reset('stopped');
    this.log('Bot stopped');
    this.emit('bot', this.getStatus());
  }

  runWebCommand(command, args) {
    if (!this.bot) throw new Error('Bot is not running');
    if (!this.bot.entity && command !== 'stop') throw new Error('Bot is connected but has not spawned yet');
    this.commandInterrupt();
    const safeArgs = args || {};
    const sender = process.env.AUTHORIZED_USER || 'roaz';
    if (command === 'follow') {
      return commands.handleCommand(this.getContext(), sender, 'follow me');
    }
    if (command === 'come') {
      return commands.handleCommand(this.getContext(), sender, 'come here');
    }
    if (command === 'stop') {
      return commands.handleCommand(this.getContext(), sender, 'stop');
    }
    if (command === 'attack') {
      if (!safeArgs.target) throw new Error('Missing attack target');
      return commands.handleCommand(this.getContext(), sender, 'attack ' + safeArgs.target);
    }
    if (command === 'go') {
      if (!isFiniteNumber(safeArgs.x) || !isFiniteNumber(safeArgs.y) || !isFiniteNumber(safeArgs.z)) {
        throw new Error('Missing or invalid coordinates');
      }
      return commands.handleCommand(this.getContext(), sender, 'go to ' + safeArgs.x + ' ' + safeArgs.y + ' ' + safeArgs.z);
    }
    if (command === 'collect_food') {
      return commands.handleCommand(this.getContext(), sender, 'collect food');
    }
    if (command === 'mine_block') {
      if (!safeArgs.block) throw new Error('Missing block name');
      return commands.handleCommand(this.getContext(), sender, 'mine ' + safeArgs.block);
    }
    if (command === 'pay') {
      if (!safeArgs.player || !isFiniteNumber(safeArgs.amount)) throw new Error('Missing payment target or amount');
      return commands.handleCommand(this.getContext(), sender, 'pay ' + safeArgs.player + ' ' + safeArgs.amount);
    }
    throw new Error('Unknown web command: ' + command);
  }

  getContext() {
    return {
      bot: this.bot,
      taskQueue: this.taskQueue,
      stateManager: this.stateManager,
      memory: this.memory,
      pvpEnabled: this.pvpEnabled,
      manager: this,
      lastEconomyCheck: this.lastEconomyCheck,
      lastOreScan: this.lastOreScan
    };
  }

  getStatus() {
    const bot = this.bot;
    return {
      running: Boolean(bot),
      aiModeEnabled: this.aiModeEnabled,
      lowPowerMode: this.lowPowerMode,
      username: bot ? bot.username : null,
      health: bot ? bot.health : null,
      hunger: bot ? bot.food : null,
      position: bot && bot.entity ? {
        x: Math.round(bot.entity.position.x * 10) / 10,
        y: Math.round(bot.entity.position.y * 10) / 10,
        z: Math.round(bot.entity.position.z * 10) / 10
      } : null,
      state: this.stateManager.getState(),
      connection: this.lastConnectionOptions ? {
        host: this.lastConnectionOptions.host,
        port: this.lastConnectionOptions.port,
        username: this.lastConnectionOptions.username,
        auth: this.lastConnectionOptions.auth
      } : null,
      queue: this.taskQueue.snapshot(),
      memory: this.memory.snapshot(),
      logs: this.logs.slice(-100)
    };
  }

  log(message) {
    const entry = {
      at: new Date().toISOString(),
      message
    };
    this.logs.push(entry);
    if (this.logs.length > 300) this.logs.shift();
    this.emit('log', entry);
  }
}

function nearestPlayerName(bot, range) {
  let best = null;
  let bestDistance = Infinity;
  Object.keys(bot.players || {}).forEach((name) => {
    const player = bot.players[name];
    if (!player || !player.entity || name === bot.username) return;
    const distance = bot.entity.position.distanceTo(player.entity.position);
    if (distance < bestDistance && distance <= range) {
      best = name;
      bestDistance = distance;
    }
  });
  return best;
}

function buildBotConfig(options) {
  const source = Object.assign({
    host: process.env.MC_HOST || 'localhost',
    port: process.env.MC_PORT || 25565,
    username: process.env.MC_USERNAME || 'AI_Bot',
    auth: process.env.MC_AUTH || 'offline',
    version: process.env.MC_VERSION || undefined
  }, options || {});
  const config = {
    host: String(source.host || 'localhost').trim() || 'localhost',
    port: Number(source.port || 25565),
    username: String(source.username || 'AI_Bot').trim() || 'AI_Bot',
    auth: String(source.auth || 'offline').trim() || 'offline'
  };
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error('Invalid Minecraft server port');
  }
  if (source.version) {
    config.version = String(source.version).trim();
  }
  return config;
}

function isFiniteNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function readPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

module.exports = new BotManager();