'use strict';

const path = require('path');
const fs   = require('fs');

const PERSIST_PATH = path.join(__dirname, '..', 'data', 'hive_memory.json');

/**
 * FAERO — Hive Mind (core/hiveMind.js)
 *
 * The central nervous system linking all fleet bots (leader + minions) into a
 * single collective intelligence. Every bot can publish intel; every bot
 * benefits from every other bot's discoveries.
 *
 * ── What it provides ──────────────────────────────────────────────────────────
 *
 *   Shared Memory Bus     — enemies, danger zones, resources broadcast to all
 *   Collective Pool       — real-time aggregated inventory across all bots
 *   Task Delegation       — assign jobs to the best-fit available bot
 *   Intel Feed            — rolling log of everything the hive knows
 *   Danger Zone Registry  — if one bot dies at coords, ALL bots avoid that area
 *
 * ── Integration ───────────────────────────────────────────────────────────────
 *
 *   botManager    → registers leader on spawn, reports enemies/deaths/resources
 *   fleetManager  → registers each minion on spawn, unregisters on dismiss
 *   web/server.js → GET /bot-api/hive/status  /intel  /pool
 *   web/socket.js → pipes hive:intel + hive:update to dashboard in real-time
 *
 * ── Socket events emitted ─────────────────────────────────────────────────────
 *
 *   hive:intel       { type, message, at }             — new intel entry
 *   hive:update      <full status snapshot>            — state changed
 *   hive:enemySpotted { botId, name, x, y, z, threat }
 *   hive:dangerZone   { botId, x, y, z, reason }
 *   hive:taskAssigned { botId, task, params }
 *   hive:taskCompleted { botId, task, result }
 *   hive:poolUpdated   (no payload — use getAggregatedPool())
 *   hive:broadcast     { event, payload, at }
 */

const EventEmitter = require('events');

const MAX_INTEL_FEED   = 120;
const MAX_DANGER_ZONES = 200;
const MAX_RESOURCES    = 500;
const DANGER_ZONE_TTL  = 10 * 60 * 1000;
const RESOURCE_TTL     =  5 * 60 * 1000;
const ENEMY_TTL        =  3 * 60 * 1000;
const POOL_STALE_TTL   =  5 * 60 * 1000;

class HiveMind extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);

    // ── Bot Registry ───────────────────────────────────────────────────────────
    // id → { role:'leader'|'soldier', bot, username, registeredAt }
    this._bots = new Map();

    // ── Shared Memory ──────────────────────────────────────────────────────────
    this._enemies     = new Map();  // name.toLowerCase() → { name, x, y, z, threat, lastSeen, seenBy }
    this._dangerZones = new Map();  // "rx,ry,rz" → { x, y, z, reason, at, reportedBy }
    this._resources   = new Map();  // "rx,ry,rz" → { type, x, y, z, discoveredAt, discoveredBy }

    // ── Resource Pool ──────────────────────────────────────────────────────────
    // botId → { items: { itemName → count }, updatedAt }
    this._pool = new Map();

    // ── Task Ledger ────────────────────────────────────────────────────────────
    // botId → { task, params, assignedAt, completedAt, result }
    this._taskLedger = new Map();

    // ── Intel Feed (rolling) ───────────────────────────────────────────────────
    this._intelFeed = [];

    this._cleanupTimer      = setInterval(() => this._cleanup(),           60 * 1000);
    this._persistTimer      = setInterval(() => this._persistMemory(),      90 * 1000);
    this._healthMonitorTimer = setInterval(() => this._checkFleetHealth(), 15 * 1000);

    // Load persisted memory from previous session
    this._loadMemory();
  }

  // ── Bot Registration ─────────────────────────────────────────────────────────

  /**
   * Register a bot (leader or minion) with the Hive Mind.
   * Pass { role: 'leader' } for the main botManager, 'soldier' for fleet minions.
   */
  registerBot(id, { role = 'soldier', bot = null, username = id } = {}) {
    this._bots.set(id, { role, bot, username, registeredAt: Date.now() });
    this._addIntel('system', '[' + username + '] linked to the Hive as ' + role);
    this.emit('hive:update', this._statusSnapshot());
  }

  /** Update the live mineflayer bot reference (call again after reconnect). */
  updateBotRef(id, bot) {
    const entry = this._bots.get(id);
    if (!entry) return;
    entry.bot = bot;
    this.emit('hive:update', this._statusSnapshot());
  }

  /** Unregister a bot (e.g. on dismiss or process exit). */
  unregisterBot(id) {
    const entry = this._bots.get(id);
    if (!entry) return;
    this._addIntel('system', '[' + entry.username + '] unlinked from the Hive');
    this._bots.delete(id);
    this._pool.delete(id);
    this._taskLedger.delete(id);
    this.emit('hive:update', this._statusSnapshot());
  }

  // ── Intel: Enemy Sightings ───────────────────────────────────────────────────

  /**
   * Report a hostile entity sighting. All bots will have this intel.
   * @param {string} botId   — which bot spotted it
   * @param {{ name, x, y, z, threat? }} opts
   */
  reportEnemy(botId, { name, x, y, z, threat = 'hostile' } = {}) {
    const key    = String(name).toLowerCase();
    const isNew  = !this._enemies.has(key);
    this._enemies.set(key, {
      name, x: Math.round(x), y: Math.round(y), z: Math.round(z),
      threat, lastSeen: Date.now(), seenBy: botId
    });
    if (isNew) {
      this._addIntel('enemy', '[' + botId + '] spotted ' + name +
        ' at ' + Math.round(x) + ',' + Math.round(y) + ',' + Math.round(z));
    }
    this.emit('hive:enemySpotted', {
      botId, name, x: Math.round(x), y: Math.round(y), z: Math.round(z), threat
    });
  }

  // ── Intel: Danger Zones ──────────────────────────────────────────────────────

  /**
   * Flag a location as dangerous (e.g. a bot died here).
   * All bots can call isDangerZone() before navigating to avoid the area.
   */
  reportDangerZone(botId, { x, y, z, reason = 'unknown' } = {}) {
    const rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
    const key = rx + ',' + ry + ',' + rz;
    this._dangerZones.set(key, {
      x: rx, y: ry, z: rz, reason, at: Date.now(), reportedBy: botId
    });
    if (this._dangerZones.size > MAX_DANGER_ZONES) {
      const oldest = Array.from(this._dangerZones.entries())
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this._dangerZones.delete(oldest[0]);
    }
    this._addIntel('danger', '[' + botId + '] ☠ flagged danger zone ' + key + ' — ' + reason);
    this.emit('hive:dangerZone', { botId, x: rx, y: ry, z: rz, reason });
    this.emit('hive:update', this._statusSnapshot());
  }

  /**
   * Returns true if a given coordinate is within radius of a known danger zone.
   * Bots should call this before navigating to any destination.
   */
  isDangerZone(x, y, z, radius = 6) {
    const cx = Math.round(x), cy = Math.round(y), cz = Math.round(z);
    for (const zone of this._dangerZones.values()) {
      const dx = zone.x - cx, dy = zone.y - cy, dz = zone.z - cz;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= radius) return true;
    }
    return false;
  }

  // ── Intel: Resource Discoveries ──────────────────────────────────────────────

  /**
   * Share a newly discovered resource with the entire fleet.
   * Duplicate positions are silently ignored (resource already known).
   */
  reportResource(botId, { type, x, y, z } = {}) {
    const rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
    const key = rx + ',' + ry + ',' + rz;
    if (this._resources.has(key)) return;
    this._resources.set(key, {
      type, x: rx, y: ry, z: rz, discoveredAt: Date.now(), discoveredBy: botId
    });
    this._addIntel('resource', '[' + botId + '] discovered ' + type +
      ' at ' + rx + ',' + ry + ',' + rz);
    if (this._resources.size > MAX_RESOURCES) {
      const oldest = Array.from(this._resources.entries())
        .sort((a, b) => a[1].discoveredAt - b[1].discoveredAt)[0];
      if (oldest) this._resources.delete(oldest[0]);
    }
    this.emit('hive:resourceFound', { botId, type, x: rx, y: ry, z: rz });
  }

  /** Get all known positions for a specific resource type. */
  getResourcesByType(type) {
    return Array.from(this._resources.values()).filter(r => r.type === type);
  }

  // ── Collective Resource Pool ─────────────────────────────────────────────────

  /**
   * Update this bot's contribution to the shared pool.
   * Call whenever a bot's inventory changes.
   * @param {string} botId
   * @param {{ [itemName]: count }} items  — full inventory summary
   */
  updatePool(botId, items) {
    this._pool.set(botId, { items: Object.assign({}, items), updatedAt: Date.now() });
    this.emit('hive:poolUpdated');
  }

  /** Total count of an item across ALL bots' inventories. */
  getPooledCount(itemName) {
    let total = 0;
    for (const { items } of this._pool.values()) total += (items[itemName] || 0);
    return total;
  }

  /**
   * Returns a merged inventory summary aggregated across all bots.
   * Top 40 items by count, sorted descending.
   */
  getAggregatedPool() {
    const agg = {};
    for (const { items } of this._pool.values()) {
      for (const [k, v] of Object.entries(items)) {
        agg[k] = (agg[k] || 0) + v;
      }
    }
    return Object.entries(agg)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .reduce((o, [k, v]) => { o[k] = v; return o; }, {});
  }

  // ── Task Delegation ──────────────────────────────────────────────────────────

  /** Assign a named task to a specific bot. */
  assignTask(botId, task, params = {}) {
    this._taskLedger.set(botId, {
      task, params, assignedAt: Date.now(), completedAt: null, result: null
    });
    this._addIntel('task', '[' + botId + '] assigned → ' + task);
    this.emit('hive:taskAssigned', { botId, task, params });
    this.emit('hive:update', this._statusSnapshot());
  }

  /** Mark a bot's task as completed. */
  completeTask(botId, result = 'done') {
    const entry = this._taskLedger.get(botId);
    if (!entry) return;
    entry.completedAt = Date.now();
    entry.result      = result;
    this._addIntel('task', '[' + botId + '] completed: ' + entry.task + ' → ' + result);
    this.emit('hive:taskCompleted', { botId, task: entry.task, result });
    this.emit('hive:update', this._statusSnapshot());
  }

  /**
   * Find the best idle bot for a task.
   * Scores bots by: health, idle status, and optionally proximity to coords.
   *
   * @param {{ x?, y?, z? }} targetCoords  — optional, boosts nearby bots
   * @param {boolean} excludeLeader        — skip the leader bot
   * @returns {string|null}                — botId or null if none available
   */
  getBestBotFor({ x, y, z } = {}, excludeLeader = false) {
    const candidates = [];
    for (const [id, entry] of this._bots.entries()) {
      if (excludeLeader && entry.role === 'leader') continue;
      if (!entry.bot || !entry.bot.entity)          continue;
      const task = this._taskLedger.get(id);
      if (task && !task.completedAt) continue;

      let score  = entry.role === 'leader' ? 2 : 10;
      if (entry.bot.health) score += entry.bot.health * 0.5;
      if (typeof x === 'number' && entry.bot.entity) {
        const pos  = entry.bot.entity.position;
        const dist = Math.sqrt((pos.x - x) ** 2 + (pos.z - z) ** 2);
        score += Math.max(0, 60 - dist);
      }
      candidates.push({ id, score });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].id;
  }

  // ── Fleet-wide Broadcast ─────────────────────────────────────────────────────

  /** Broadcast a custom event to every registered bot listener. */
  broadcast(event, payload) {
    this.emit('hive:broadcast', { event, payload, at: new Date().toISOString() });
  }

  // ── Status API ───────────────────────────────────────────────────────────────

  getStatus()              { return this._statusSnapshot(); }
  getIntelFeed(n = 40)     { return this._intelFeed.slice(-n); }
  getDangerZones()         { return Array.from(this._dangerZones.values()); }
  getKnownEnemies()        { return Array.from(this._enemies.values()); }

  // ── Internals ────────────────────────────────────────────────────────────────

  _statusSnapshot() {
    const bots = [];
    for (const [id, e] of this._bots.entries()) {
      const b    = e.bot;
      const task = this._taskLedger.get(id);
      bots.push({
        id, username: e.username, role: e.role,
        online:   Boolean(b && b.entity),
        health:   b ? b.health : null,
        hunger:   b ? b.food   : null,
        position: b && b.entity ? {
          x: Math.round(b.entity.position.x),
          y: Math.round(b.entity.position.y),
          z: Math.round(b.entity.position.z)
        } : null,
        currentTask:   (task && !task.completedAt) ? task.task : null,
        survivalState: e.survivalState || null
      });
    }
    return {
      bots,
      totalBots:        this._bots.size,
      onlineBots:       bots.filter(b => b.online).length,
      knownEnemies:     Array.from(this._enemies.values()),
      dangerZoneCount:  this._dangerZones.size,
      dangerZones:      Array.from(this._dangerZones.values()).slice(-20),
      recentResources:  Array.from(this._resources.values()).slice(-15).reverse(),
      pool:             this.getAggregatedPool(),
      taskLedger:       Array.from(this._taskLedger.entries())
                          .map(([id, t]) => ({ botId: id, ...t })),
      intelFeed:        this._intelFeed.slice(-40)
    };
  }

  _addIntel(type, message) {
    const entry = { type, message, at: new Date().toISOString() };
    this._intelFeed.push(entry);
    if (this._intelFeed.length > MAX_INTEL_FEED) this._intelFeed.shift();
    this.emit('hive:intel', entry);
  }

  _cleanup() {
    const now = Date.now();
    for (const [k, z] of this._dangerZones.entries())
      if (now - z.at > DANGER_ZONE_TTL) this._dangerZones.delete(k);
    for (const [k, r] of this._resources.entries())
      if (now - r.discoveredAt > RESOURCE_TTL) this._resources.delete(k);
    for (const [k, e] of this._enemies.entries())
      if (now - e.lastSeen > ENEMY_TTL) this._enemies.delete(k);
    for (const [id, p] of this._pool.entries())
      if (now - p.updatedAt > POOL_STALE_TTL && !this._bots.has(id))
        this._pool.delete(id);
  }

  // ── Fleet Health Monitor ─────────────────────────────────────────────────────

  /**
   * Runs every 15 s. If the fleet's average HP drops below 35%, broadcasts a
   * hive:retreatSignal so every bot can act on it (e.g. stop combat, go home).
   */
  _checkFleetHealth() {
    const hpValues = [];
    for (const entry of this._bots.values()) {
      if (entry.bot && entry.bot.entity && entry.bot.health != null) {
        hpValues.push(entry.bot.health);
      }
    }
    if (hpValues.length < 2) return;
    const avg = hpValues.reduce((a, b) => a + b, 0) / hpValues.length;
    const pct = Math.round((avg / 20) * 100);
    if (pct < 35) {
      this._addIntel('system', '⚠ Fleet health critical: ' + pct + '% avg HP (' + Math.round(avg) + '/20) — retreat signal sent');
      this.broadcast('retreat', { reason: 'fleet_health_critical', avgHp: Math.round(avg), pct });
      this.emit('hive:retreatSignal', { avgHp: Math.round(avg), pct });
    }
  }

  // ── Danger Zone Persistence ──────────────────────────────────────────────────

  /**
   * Serialize danger zones to disk so they survive bot restarts.
   * Called every 90 s and on destroy().
   */
  _persistMemory() {
    try {
      const dir = path.dirname(PERSIST_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {
        version:     1,
        savedAt:     new Date().toISOString(),
        dangerZones: Array.from(this._dangerZones.entries())
      };
      fs.writeFileSync(PERSIST_PATH, JSON.stringify(data, null, 2));
    } catch (_) {}
  }

  /**
   * Load persisted memory on startup.
   * Called once from constructor.
   */
  _loadMemory() {
    try {
      if (!fs.existsSync(PERSIST_PATH)) return;
      const raw  = fs.readFileSync(PERSIST_PATH, 'utf8');
      const data = JSON.parse(raw);
      if (data.dangerZones && Array.isArray(data.dangerZones)) {
        const now = Date.now();
        let loaded = 0;
        data.dangerZones.forEach(([key, zone]) => {
          // Only restore zones that haven't expired yet
          if (zone.at && (now - zone.at) < DANGER_ZONE_TTL) {
            this._dangerZones.set(key, zone);
            loaded++;
          }
        });
        if (loaded > 0) {
          this._addIntel('system', 'Restored ' + loaded + ' danger zone(s) from previous session');
        }
      }
    } catch (_) {}
  }

  destroy() {
    this._persistMemory();
    if (this._cleanupTimer)       clearInterval(this._cleanupTimer);
    if (this._persistTimer)       clearInterval(this._persistTimer);
    if (this._healthMonitorTimer) clearInterval(this._healthMonitorTimer);
    this.removeAllListeners();
  }
}

module.exports = new HiveMind();
