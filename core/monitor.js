'use strict';

/**
 * ResourceMonitor — Self-monitoring module for FAERO Minecraft Bot
 *
 * Tracks process heap memory AND CPU usage.
 * If SAFE_HEAP_MB is exceeded the bot auto-disconnects and fires a Discord alert.
 * CPU usage is sampled on every check interval and exposed in getStats().
 *
 * This module performs NO network scanning, NO packet manipulation, and
 * NO activity that would violate Replit's Terms of Service. All monitoring
 * is strictly local (process.memoryUsage / process.cpuUsage) and read-only.
 *
 * Personal, non-commercial use only. See README.md.
 */

const EventEmitter = require('events');

// ── Configurable thresholds ────────────────────────────────────────────────────
const SAFE_HEAP_MB        = Number(process.env.SAFE_HEAP_MB)        || 400;
const MONITOR_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS) || 30000;

// Action-rate window: max bot actions per time window (anti-spam / anti-cheat
// compliance — avoids triggering server-side rate limits).
const ACTION_WINDOW_MS       = 10000;
const MAX_ACTIONS_PER_WINDOW = Number(process.env.MAX_ACTIONS_PER_WINDOW) || 15;

class ResourceMonitor extends EventEmitter {
  constructor(botManager) {
    super();
    this.botManager = botManager;
    this._timer          = null;
    this._alerted        = false;
    this._recoveryTimer  = null;
    this._actionTimestamps = [];

    // CPU tracking
    this._cpuUsageSnapshot  = null;  // last process.cpuUsage() sample
    this._cpuSampledAt      = 0;
    this._cpuPercent        = 0;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start() {
    if (this._timer) return;
    this._cpuUsageSnapshot = process.cpuUsage();
    this._cpuSampledAt     = Date.now();
    this._timer = setInterval(() => this._check(), MONITOR_INTERVAL_MS);
    this.botManager.log(
      '[monitor] Started — heap limit: ' + SAFE_HEAP_MB + 'MB' +
      ' | check every ' + (MONITOR_INTERVAL_MS / 1000) + 's' +
      ' | max ' + MAX_ACTIONS_PER_WINDOW + ' actions / ' + (ACTION_WINDOW_MS / 1000) + 's'
    );
  }

  stop() {
    if (this._timer)         { clearInterval(this._timer);       this._timer = null; }
    if (this._recoveryTimer) { clearTimeout(this._recoveryTimer); this._recoveryTimer = null; }
  }

  // ── Action rate gate ────────────────────────────────────────────────────────
  // Call before any bot action. Returns false if the action rate is too high,
  // which prevents spam / anti-cheat detection on the server side.

  checkActionRate() {
    const now = Date.now();
    this._actionTimestamps = this._actionTimestamps.filter((t) => now - t < ACTION_WINDOW_MS);
    if (this._actionTimestamps.length >= MAX_ACTIONS_PER_WINDOW) return false;
    this._actionTimestamps.push(now);
    return true;
  }

  // ── CPU sample ─────────────────────────────────────────────────────────────

  _sampleCpu() {
    const now     = Date.now();
    const elapsed = Math.max(1, now - this._cpuSampledAt);
    const prev    = this._cpuUsageSnapshot || process.cpuUsage();
    const delta   = process.cpuUsage(prev);
    // delta.user + delta.system are in microseconds
    const cpuMs   = (delta.user + delta.system) / 1000;
    this._cpuPercent       = Math.min(100, Math.max(0, Math.round((cpuMs / elapsed) * 100)));
    this._cpuUsageSnapshot = process.cpuUsage();
    this._cpuSampledAt     = now;
    return this._cpuPercent;
  }

  // ── Resource check ──────────────────────────────────────────────────────────

  _check() {
    const cpuPct = this._sampleCpu();
    const stats  = this.getStats();

    this.botManager.log(
      '[monitor] Heap: ' + stats.heapMB + '/' + SAFE_HEAP_MB + 'MB' +
      ' | RSS: ' + stats.rssMB + 'MB' +
      ' | CPU: ' + cpuPct + '%' +
      ' | Uptime: ' + stats.uptimeMin + 'min'
    );

    if (stats.heapMB >= SAFE_HEAP_MB && !this._alerted) {
      this._alerted = true;
      const msg =
        'MEMORY ALERT: Heap at ' + stats.heapMB + 'MB — safe limit is ' + SAFE_HEAP_MB + 'MB. ' +
        'Auto-disconnecting bot to free resources.';
      this.botManager.log('[monitor] ' + msg);
      this.emit('alert', msg);

      if (this.botManager.bot) {
        this.botManager.stop();
      }

      // Allow re-alert after 60 s if memory remains high
      this._recoveryTimer = setTimeout(() => {
        this._alerted      = false;
        this._recoveryTimer = null;
      }, 60000);
    }
  }

  // ── Public stats ────────────────────────────────────────────────────────────

  getStats() {
    const mem = process.memoryUsage();
    return {
      heapMB:     Math.round(mem.heapUsed / 1024 / 1024),
      rssMB:      Math.round(mem.rss      / 1024 / 1024),
      limitMB:    SAFE_HEAP_MB,
      cpuPercent: this._cpuPercent,
      uptimeMin:  Math.round(process.uptime() / 60)
    };
  }
}

module.exports = ResourceMonitor;
