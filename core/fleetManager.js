'use strict';

const hiveMind = require('./hiveMind');

/**
 * FAERO — Fleet Manager (core/fleetManager.js)
 *
 * Manages a dynamic array of lightweight Minion bot instances alongside the
 * main Leader bot (botManager). Clean architecture for scaling bots dynamically.
 *
 * ── Architecture ──────────────────────────────────────────────────────────────
 *
 *   FleetManager (singleton)
 *     ├── leader: botManager  ← the full-featured main bot (READ-ONLY reference)
 *     └── minions: FleetBot[] ← lightweight mineflayer bots with follow + combat
 *
 *   The existing botManager is NEVER modified — fleet is purely additive.
 *
 * ── In-game group commands (ADMIN tier) ───────────────────────────────────────
 *   !all follow              Follow the leader
 *   !all stop                Stop all movement
 *   !all come                Navigate to leader now
 *   !all join                Reconnect offline minions
 *   !all leave               Disconnect (but keep spawned)
 *   !all attack <name>       Attack named entity
 *   !all build <schematic>   Distribute build across fleet
 *
 * ── REST API ──────────────────────────────────────────────────────────────────
 *   GET  /bot-api/fleet/status
 *   GET  /bot-api/fleet/inventory
 *   POST /bot-api/fleet/spawn       { username, host?, port?, auth?, version? }
 *   POST /bot-api/fleet/dismiss/:id
 *   POST /bot-api/fleet/dismiss-all
 *   POST /bot-api/fleet/command     { cmd, target? }
 *   POST /bot-api/fleet/build       { name } | { schematic: {...} }
 *
 * ── Socket events ─────────────────────────────────────────────────────────────
 *   fleet:update  → real-time status of all fleet bots
 *   fleet:log     → log entries from any fleet bot
 *
 * ── Spread offsets ────────────────────────────────────────────────────────────
 *   Minions follow at staggered positions to avoid stacking:
 *   index 0 → +2 east, index 1 → +2 west, index 2 → +2 south, etc.
 */

const EventEmitter = require('events');
const mineflayer   = require('mineflayer');

const { pathfinder: pathfinderPlugin, goals, Movements } =
  require('mineflayer-pathfinder');
const pvpPlugin = require('mineflayer-pvp').plugin;

// Spread offsets [dx, dy, dz] relative to the leader's position for each minion index
const FOLLOW_OFFSETS = [
  [ 2, 0,  0], [-2, 0,  0],
  [ 0, 0,  2], [ 0, 0, -2],
  [ 3, 0,  1], [-3, 0,  1],
  [ 1, 0, -3], [-1, 0,  3]
];

let _nextMinionId = 1;

// ── FleetBot ──────────────────────────────────────────────────────────────────
// A lightweight mineflayer bot wrapper for fleet minions.
// Does NOT have full AI brain, farming scheduler, or anti-detection — just
// pathfinding, combat, and status reporting.

class FleetBot extends EventEmitter {
  constructor(id, options) {
    super();
    this.id       = id;
    this.username = String(options.username).trim();
    this.options  = Object.assign(
      { host: 'localhost', port: 25565, auth: 'offline' },
      options,
      { username: this.username }
    );
    this.bot             = null;
    this.state           = 'offline';   // offline | connecting | online | following | busy | error
    this._following      = false;       // whether follow mode is active
    this.shouldReconnect = false;
    this._reconnectTimer = null;
  }

  // ── Connection lifecycle ────────────────────────────────────────────────────

  async connect() {
    if (['connecting', 'online', 'following', 'busy'].includes(this.state)) return;
    this._setState('connecting');
    this.log('Connecting to ' + this.options.host + ':' + this.options.port + '…');

    const config = {
      host:     String(this.options.host     || 'localhost').trim(),
      port:     Number(this.options.port     || 25565),
      username: this.username,
      auth:     String(this.options.auth     || 'offline').trim()
    };
    if (this.options.version) config.version = String(this.options.version).trim();

    const bot = mineflayer.createBot(config);
    this.bot = bot;

    bot.loadPlugin(pathfinderPlugin);
    bot.loadPlugin(pvpPlugin);

    bot.once('spawn', () => {
      this._setState('online');
      this.log('Spawned — ready');
      const movements = new Movements(bot);
      movements.canDig = false;
      movements.allowSprinting = true;
      bot.pathfinder.setMovements(movements);
    });

    bot.on('chat', (username, message) => {
      if (username === this.username) return;
      this.log('<' + username + '> ' + message);
    });

    bot.on('health', () => {
      this.emit('statusChange', this.getStatus());
    });

    bot.on('error', (err) => {
      this.log('Error: ' + (err && err.message ? err.message : String(err)));
      this._setState('error');
    });

    bot.on('kicked', (reason) => {
      this.log('Kicked: ' + String(reason).slice(0, 120));
      this.emit('kicked', { id: this.id, username: this.username, reason: String(reason).slice(0, 200) });
    });

    bot.on('end', () => {
      this.bot = null;
      this._following = false;
      this._setState('offline');
      this.log('Disconnected');
      if (this.shouldReconnect) {
        this._reconnectTimer = setTimeout(() => {
          if (this.shouldReconnect) this.connect().catch(() => {});
        }, 8000);
      }
    });
  }

  disconnect() {
    this.shouldReconnect = false;
    this._following = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.bot) {
      try { this.bot.removeAllListeners('end'); this.bot.quit('fleet dismiss'); } catch (_) {}
      try { this.bot.end(); } catch (_) {}
      this.bot = null;
    }
    this._setState('offline');
  }

  // ── Movement ────────────────────────────────────────────────────────────────

  async followPosition(x, y, z, range) {
    if (!this.bot || !this.bot.entity) return;
    try {
      await this.bot.pathfinder.goto(new goals.GoalNear(x, y, z, range || 2));
    } catch (_) {}
  }

  stopMovement() {
    this._following = false;
    if (!this.bot) return;
    try { this.bot.pathfinder.setGoal(null); this.bot.pathfinder.stop(); } catch (_) {}
    ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].forEach((k) => {
      try { this.bot.setControlState(k, false); } catch (_) {}
    });
    if (this.state === 'following') this._setState('online');
  }

  // ── Combat ──────────────────────────────────────────────────────────────────

  attackTarget(targetName) {
    const bot = this.bot;
    if (!bot || !bot.entity) return false;
    const lowerName = targetName.toLowerCase();
    const entity = bot.nearestEntity((e) =>
      (e.username && e.username.toLowerCase() === lowerName) ||
      (e.name    && e.name.toLowerCase()     === lowerName)
    );
    if (!entity) return false;
    try { bot.attack(entity); return true; } catch (_) { return false; }
  }

  // ── Status snapshots ─────────────────────────────────────────────────────────

  getStatus() {
    const b = this.bot;
    return {
      id:        this.id,
      username:  this.username,
      state:     this.state,
      health:    b ? (b.health != null ? Math.round(b.health * 10) / 10 : null) : null,
      hunger:    b ? (b.food   != null ? b.food : null) : null,
      position:  b && b.entity ? {
        x: Math.round(b.entity.position.x * 10) / 10,
        y: Math.round(b.entity.position.y * 10) / 10,
        z: Math.round(b.entity.position.z * 10) / 10
      } : null,
      following: this._following,
      invCount:  b ? b.inventory.items().length : 0,
      host:      this.options.host,
      port:      this.options.port
    };
  }

  getInventory() {
    const b = this.bot;
    if (!b || !b.inventory) return { id: this.id, username: this.username, slots: [] };
    return {
      id: this.id,
      username: this.username,
      slots: b.inventory.items().map((item) => ({
        name:        item.name,
        displayName: item.displayName || item.name,
        count:       item.count
      }))
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  _setState(newState) {
    this.state = newState;
    this.emit('statusChange', this.getStatus());
  }

  log(msg) {
    this.emit('log', { at: new Date().toISOString(), message: '[' + this.id + '] ' + msg });
  }
}

// ── FleetManager ──────────────────────────────────────────────────────────────

class FleetManager extends EventEmitter {
  constructor() {
    super();
    this._leader         = null;  // main botManager reference (leader)
    this._minions        = [];    // FleetBot[]
    this._followTimer    = null;  // setInterval handle for follow loop
    this._broadcastTimer = null;  // setInterval handle for status broadcast
    this._initialized    = false;
  }

  // ── Initialise (call once from server setup) ─────────────────────────────────

  init(leaderBotManager) {
    if (this._initialized) return;
    this._initialized = true;
    this._leader = leaderBotManager;
    this._startFollowLoop();
    this._startBroadcast();
  }

  // ── Spawn / dismiss ───────────────────────────────────────────────────────────

  /**
   * Spawn a new minion bot.
   * @param {{ username, host?, port?, auth?, version? }} options
   * @returns {string} the minion's id
   */
  spawn(options) {
    if (!options || !options.username) throw new Error('"username" is required to spawn a fleet bot');
    const username = String(options.username).trim();
    if (!username) throw new Error('Username cannot be empty');
    if (this._minions.find((m) => m.username === username)) {
      throw new Error('A fleet bot named "' + username + '" already exists');
    }

    const id     = 'minion_' + (_nextMinionId++);
    const minion = new FleetBot(id, options);

    minion.on('log',          (e) => {
      this.emit('fleet:log', e);
    });
    minion.on('statusChange', () => {
      this._broadcastNow();
      hiveMind.updateBotRef(id, minion.bot);
    });
    minion.on('kicked', (data) => this.emit('fleet:botKicked', data));

    // ── Hive Mind: register this minion ──────────────────────────────────────
    hiveMind.registerBot(id, { role: 'soldier', bot: null, username });

    // Wire minion bot ref into hive once it spawns
    minion.on('statusChange', () => {
      if (minion.bot && minion.bot.entity) {
        hiveMind.updateBotRef(id, minion.bot);
        // Sync inventory to pool whenever online
        if (minion.bot.inventory) {
          const items = {};
          minion.bot.inventory.items().forEach((it) => {
            items[it.name] = (items[it.name] || 0) + it.count;
          });
          hiveMind.updatePool(id, items);
        }
      }
    });

    this._minions.push(minion);
    minion.connect().catch((err) => minion.log('Connect error: ' + err.message));
    this.log('[fleet] Spawned ' + id + ' (' + username + ') → ' + options.host + ':' + options.port);
    this._broadcastNow();
    return id;
  }

  /**
   * Remove a minion by its id or username.
   */
  dismiss(idOrUsername) {
    const idx = this._minions.findIndex(
      (m) => m.id === idOrUsername || m.username === idOrUsername
    );
    if (idx === -1) throw new Error('No fleet bot found with id/username "' + idOrUsername + '"');
    const minion = this._minions[idx];
    // ── Hive Mind: unregister ────────────────────────────────────────────────
    hiveMind.unregisterBot(minion.id);
    minion.disconnect();
    this._minions.splice(idx, 1);
    this.log('[fleet] Dismissed ' + minion.id + ' (' + minion.username + ')');
    this._broadcastNow();
  }

  dismissAll() {
    // ── Hive Mind: unregister all minions ────────────────────────────────────
    this._minions.forEach((m) => hiveMind.unregisterBot(m.id));
    this._minions.forEach((m) => m.disconnect());
    this._minions = [];
    this.log('[fleet] All minions dismissed');
    this._broadcastNow();
  }

  // ── Group commands ────────────────────────────────────────────────────────────

  /**
   * Send a command to every online minion.
   * @param {'follow'|'stop'|'come'|'attack'|'join'|'leave'} cmd
   * @param {string|null} [arg]  target name for 'attack', otherwise null
   */
  groupCommand(cmd, arg) {
    const leader    = this._leader && this._leader.bot;
    const leaderPos = leader && leader.entity && leader.entity.position;

    switch (cmd) {

      case 'follow':
        this._minions.forEach((m) => {
          m._following = true;
          if (m.state === 'online') m.state = 'following';
        });
        this.log('[fleet] Follow mode ON — minions will track the leader');
        break;

      case 'stop':
        this._minions.forEach((m) => m.stopMovement());
        this.log('[fleet] All minions stopped');
        break;

      case 'come':
        if (!leaderPos) {
          this.log('[fleet] Leader is not online — cannot issue come command');
          break;
        }
        this._minions.forEach((m, i) => {
          if (!m.bot || !m.bot.entity) return;
          const off = FOLLOW_OFFSETS[i % FOLLOW_OFFSETS.length];
          m.followPosition(leaderPos.x + off[0], leaderPos.y, leaderPos.z + off[2], 2)
           .catch(() => {});
        });
        this.log('[fleet] Come here — all minions navigating to leader');
        break;

      case 'attack':
        if (!arg) { this.log('[fleet] Attack requires a target name'); break; }
        {
          let hits = 0;
          this._minions.forEach((m) => { if (m.attackTarget(arg)) hits++; });
          this.log('[fleet] Attack "' + arg + '" — ' + hits + ' minion(s) engaged');
        }
        break;

      case 'join':
        this._minions.forEach((m) => {
          if (m.state === 'offline' || m.state === 'error') {
            m.connect().catch(() => {});
          }
        });
        this.log('[fleet] Join — reconnecting offline/error minions');
        break;

      case 'leave':
        this._minions.forEach((m) => {
          m.shouldReconnect = false;
          m._following      = false;
          if (m.bot) {
            try { m.bot.removeAllListeners('end'); m.bot.quit('all leave'); } catch (_) {}
            m.bot = null;
          }
          m.state = 'offline';
        });
        this.log('[fleet] Leave — all minions disconnected (still registered)');
        break;

      default:
        this.log('[fleet] Unknown group command: ' + String(cmd));
    }

    this._broadcastNow();
  }

  // ── Distributed build ─────────────────────────────────────────────────────────

  /**
   * Split a schematic's block list across all online bots (leader + minions).
   * Each bot places its chunk in parallel, bypassing the autoBuild singleton.
   *
   * @param {string|object} schematicInput  built-in name, JSON string, or object
   * @returns {Promise<{ placed, failed, bots }>}
   */
  async distributeBuild(schematicInput) {
    const autoBuild = require('../modules/autoBuild');
    const leader    = this._leader && this._leader.bot;
    if (!leader || !leader.entity) throw new Error('Leader bot must be online for distributed build');

    const origin           = leader.entity.position;
    const { blocks, name } = autoBuild.parseSchematic(schematicInput, origin);

    // Build the participant list: leader first, then online minions
    const participants = [
      { bot: leader, label: 'leader' },
      ...this._minions
          .filter((m) => m.bot && m.bot.entity)
          .map((m) => ({ bot: m.bot, label: m.id }))
    ];

    if (!participants.length) throw new Error('No online bots available for distributed build');

    const n         = participants.length;
    const chunkSize = Math.ceil(blocks.length / n);

    this.log('[fleet] Distributing "' + name + '" (' + blocks.length + ' blocks) across ' + n + ' bot(s)');
    this.emit('fleet:buildStart', { name, totalBlocks: blocks.length, bots: n });

    const promises = participants.map(({ bot: b, label }, i) => {
      const chunk = blocks.slice(i * chunkSize, (i + 1) * chunkSize);
      if (!chunk.length) return Promise.resolve({ placed: 0, skipped: 0, failed: 0 });
      return this._runChunk(autoBuild, b, chunk, label);
    });

    const settled = await Promise.allSettled(promises);
    const totals  = settled.reduce((acc, r) => {
      const v = r.status === 'fulfilled' ? r.value : { placed: 0, failed: 0 };
      acc.placed += v.placed || 0;
      acc.failed += v.failed || 0;
      return acc;
    }, { placed: 0, failed: 0 });

    this.log('[fleet] "' + name + '" complete — ' + totals.placed + ' placed, ' + totals.failed + ' failed');
    this.emit('fleet:buildComplete', { name, placed: totals.placed, failed: totals.failed, bots: n });
    return { placed: totals.placed, failed: totals.failed, bots: n, name };
  }

  // Runs autoBuild.placeOneBlock in a loop for one chunk, without touching the
  // autoBuild singleton session (so multiple bots can build in parallel).
  async _runChunk(autoBuild, bot, blocks, label) {
    let placed = 0, skipped = 0, failed = 0;
    const logFn = (msg) => this.emit('fleet:log', {
      at: new Date().toISOString(),
      message: '[' + label + '] ' + msg
    });

    for (const block of blocks) {
      const result = await autoBuild.placeOneBlock(
        bot, block.x, block.y, block.z, block.type, logFn
      );
      if (result === 'placed')  { placed++;  }
      if (result === 'skipped') { skipped++; }
      if (result === 'failed')  { failed++;  }
      if (placed > 0 && placed % 10 === 0) {
        logFn('chunk progress: ' + placed + ' placed');
      }
    }
    return { placed, skipped, failed };
  }

  // ── Status snapshots ─────────────────────────────────────────────────────────

  getStatus() {
    const leader    = this._leader;
    const leaderBot = leader && leader.bot;
    return {
      leader: {
        username: leaderBot
          ? leaderBot.username
          : (leader && leader.lastConnectionOptions && leader.lastConnectionOptions.username) || null,
        state:    leader ? leader.stateManager.getState().state : 'offline',
        health:   leaderBot ? leaderBot.health : null,
        hunger:   leaderBot ? leaderBot.food   : null,
        position: leaderBot && leaderBot.entity ? {
          x: Math.round(leaderBot.entity.position.x * 10) / 10,
          y: Math.round(leaderBot.entity.position.y * 10) / 10,
          z: Math.round(leaderBot.entity.position.z * 10) / 10
        } : null,
        online: Boolean(leaderBot && leaderBot.entity)
      },
      minions: this._minions.map((m) => m.getStatus()),
      total:   this._minions.length
    };
  }

  getInventories() {
    return {
      minions: this._minions.map((m) => m.getInventory()),
      total:   this._minions.length
    };
  }

  // ── Internal: follow loop ─────────────────────────────────────────────────────
  // Polls the leader's position every 2 s. If a minion is in follow mode and
  // has drifted > 4 blocks from its target spread position, it navigates back.

  _startFollowLoop() {
    if (this._followTimer) return;
    this._followTimer = setInterval(() => {
      const leader    = this._leader && this._leader.bot;
      if (!leader || !leader.entity) return;
      const lp = leader.entity.position;

      this._minions.forEach((minion, i) => {
        if (!minion._following)           return;
        if (!minion.bot || !minion.bot.entity) return;

        const off  = FOLLOW_OFFSETS[i % FOLLOW_OFFSETS.length];
        const tx   = lp.x + off[0];
        const ty   = lp.y;
        const tz   = lp.z + off[2];
        const mp   = minion.bot.entity.position;
        const dist = Math.sqrt(
          (mp.x - tx) * (mp.x - tx) +
          (mp.y - ty) * (mp.y - ty) +
          (mp.z - tz) * (mp.z - tz)
        );

        if (dist > 4) {
          minion.state = 'following';
          minion.followPosition(tx, ty, tz, 2).catch(() => {});
        }
      });
    }, 2000);
  }

  _stopFollowLoop() {
    if (this._followTimer) { clearInterval(this._followTimer); this._followTimer = null; }
  }

  // ── Internal: status broadcast ────────────────────────────────────────────────

  _startBroadcast() {
    if (this._broadcastTimer) return;
    this._broadcastTimer = setInterval(() => this._broadcastNow(), 4000);
  }

  _broadcastNow() {
    this.emit('fleet:update', this.getStatus());
  }

  // ── Logging ───────────────────────────────────────────────────────────────────

  log(msg) {
    const entry = { at: new Date().toISOString(), message: msg };
    if (this._leader) this._leader.log(msg);
    this.emit('fleet:log', entry);
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

module.exports = new FleetManager();
