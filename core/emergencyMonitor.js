'use strict';

/**
 * EmergencyMonitor — non-blocking watchdog for critical bot states.
 *
 * Triggers a single Discord red-themed alert (with @owner mention) when:
 *   • Health drops below HEALTH_CRITICAL (default 15% = 3 HP / 20).
 *   • Bot took damage from a hostile source within COMBAT_WINDOW_MS.
 *   • Bot disconnects unexpectedly.
 *
 * Each condition is rate-limited via per-reason cooldown so the bot does not
 * spam Discord during sustained events. All work is performed in setInterval
 * callbacks — the main bot loop is never blocked.
 */

const EventEmitter = require('events');

const POLL_MS               = 5000;
const HEALTH_CRITICAL_PCT   = Number(process.env.EMERGENCY_HEALTH_PCT) || 15;
const COMBAT_WINDOW_MS      = Number(process.env.EMERGENCY_COMBAT_WINDOW_MS) || 8000;
const REASON_COOLDOWN_MS    = Number(process.env.EMERGENCY_REASON_COOLDOWN_MS) || 60000;

class EmergencyMonitor extends EventEmitter {
  constructor(botManager) {
    super();
    this.botManager = botManager;
    this._timer = null;
    this._lastAlerts = new Map(); // reason -> timestamp
    this._lastDamageAt = 0;
    this._wasConnected = false;
    this._botListenersBound = false;
    this._currentSeverity = 'normal';
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), POLL_MS);
    this.botManager.on('bot', () => this._maybeBindBotListeners());
    this._maybeBindBotListeners();
    this.botManager.log('[emergency] Monitor armed — health<' + HEALTH_CRITICAL_PCT + '% / combat / disconnect');
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  getSeverity() {
    return this._currentSeverity;
  }

  _maybeBindBotListeners() {
    const bot = this.botManager && this.botManager.bot;
    if (!bot || this._botListenersBound) return;
    this._botListenersBound = true;
    bot.on('entityHurt', (entity) => {
      if (!bot.entity || entity.id !== bot.entity.id) return;
      this._lastDamageAt = Date.now();
    });
    bot.once('end', () => { this._botListenersBound = false; });
  }

  _tick() {
    const bm = this.botManager;
    const status = bm.getStatus();
    const wasConnected = this._wasConnected;
    this._wasConnected = Boolean(status.running);

    // ── Disconnect detection ─────────────────────────────────────────────
    if (wasConnected && !status.running) {
      this._fire('disconnect', 'Bot lost connection to Minecraft server.', { previousState: status.state });
    }

    // ── Health critical ──────────────────────────────────────────────────
    if (status.running && typeof status.health === 'number') {
      const pct = Math.round((status.health / 20) * 100);
      if (pct <= HEALTH_CRITICAL_PCT) {
        this._fire('low_hp', 'Health critical: ' + status.health + '/20 (' + pct + '%).', { health: status.health, hunger: status.hunger });
      }
    }

    // ── Active combat ────────────────────────────────────────────────────
    const inCombat = (Date.now() - this._lastDamageAt) < COMBAT_WINDOW_MS;
    if (status.running && inCombat) {
      this._fire('combat', 'Bot is under attack — recent damage detected.', { health: status.health });
    }

    // ── Update severity for dashboard widget ─────────────────────────────
    if (!status.running) this._currentSeverity = 'critical';
    else if (inCombat || (typeof status.health === 'number' && status.health <= 6)) this._currentSeverity = 'warning';
    else this._currentSeverity = 'normal';
  }

  _fire(reason, message, meta) {
    const now = Date.now();
    const last = this._lastAlerts.get(reason) || 0;
    if (now - last < REASON_COOLDOWN_MS) return;
    this._lastAlerts.set(reason, now);
    const payload = { reason, message, meta: meta || {}, at: new Date().toISOString() };
    this.botManager.log('[emergency] ' + reason + ' — ' + message);
    this.emit('alert', payload);
  }
}

module.exports = EmergencyMonitor;
