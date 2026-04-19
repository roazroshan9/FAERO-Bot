/**
 * ResourceMonitor — Self-monitoring module for FAERO Minecraft Bot
 *
 * Purpose: Tracks process memory usage and enforces safe resource limits
 * to prevent Replit from suspending the repl due to excessive consumption.
 *
 * This module performs NO network scanning, NO packet manipulation, and
 * NO activity that would violate Replit's Terms of Service. All monitoring
 * is strictly local (process.memoryUsage) and read-only.
 *
 * Personal, non-commercial use only. See README.md.
 */

'use strict';

const EventEmitter = require('events');

// ─── Configurable Thresholds ──────────────────────────────────────────────────
// SAFE_HEAP_MB  — heap usage (MB) that triggers auto-disconnect & Discord alert.
//                 Replit free tier containers typically have ~512 MB available;
//                 default is 400 MB to leave a 100 MB safety margin.
const SAFE_HEAP_MB      = Number(process.env.SAFE_HEAP_MB)      || 400;
const MONITOR_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS) || 30000;

// Action-rate window: max bot actions per time window (anti-spam / anti-cheat
// compliance — avoids triggering server-side rate limits).
const ACTION_WINDOW_MS    = 10000;
const MAX_ACTIONS_PER_WINDOW = Number(process.env.MAX_ACTIONS_PER_WINDOW) || 15;

class ResourceMonitor extends EventEmitter {
  constructor(botManager) {
    super();
    this.botManager = botManager;
    this._timer = null;
    this._alerted = false;
    this._recoveryTimer = null;
    this._actionTimestamps = [];
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._check(), MONITOR_INTERVAL_MS);
    this.botManager.log(
      '[monitor] Started — heap limit: ' + SAFE_HEAP_MB + 'MB' +
      ' | check every ' + (MONITOR_INTERVAL_MS / 1000) + 's' +
      ' | max ' + MAX_ACTIONS_PER_WINDOW + ' actions / ' + (ACTION_WINDOW_MS / 1000) + 's'
    );
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
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

  // ── Resource check ──────────────────────────────────────────────────────────

  _check() {
    const stats = this.getStats();
    this.botManager.log(
      '[monitor] Heap: ' + stats.heapMB + '/' + SAFE_HEAP_MB + 'MB' +
      ' | RSS: ' + stats.rssMB + 'MB' +
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
        this._alerted = false;
        this._recoveryTimer = null;
      }, 60000);
    }
  }

  // ── Public stats ────────────────────────────────────────────────────────────

  getStats() {
    const mem = process.memoryUsage();
    return {
      heapMB:    Math.round(mem.heapUsed   / 1024 / 1024),
      rssMB:     Math.round(mem.rss        / 1024 / 1024),
      limitMB:   SAFE_HEAP_MB,
      uptimeMin: Math.round(process.uptime() / 60)
    };
  }
}

module.exports = ResourceMonitor;
