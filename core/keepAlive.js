/**
 * FAERO — KeepAlive Watchdog (core/keepAlive.js)
 *
 * Monitors connection health and event-loop responsiveness so the bot
 * doesn't silently lag out from the server while running heavy tasks
 * (area scans, mode timers, pathfinding).
 *
 * Two independent checks:
 *   1. Packet activity   — warns if no server packet in PACKET_WARN_MS
 *                          (server times us out around 30 s of silence)
 *   2. Event-loop lag    — warns if a setTimeout(0) is delayed > LAG_WARN_MS
 *                          (indicates blocking work; should never happen here)
 *
 * Mineflayer responds to KeepAlive packets natively, so we only need to
 * detect when something on OUR side is starving the loop.
 */

'use strict';

const PACKET_WARN_MS = 22000;  // warn at 22 s of packet silence (server kicks at 30 s)
const LAG_WARN_MS    = 1500;   // warn if event loop blocked > 1.5 s
const CHECK_EVERY    = 5000;   // run watchdog every 5 s

class KeepAlive {
  constructor(opts) {
    this._lastPacket  = Date.now();
    this._lastLagMark = Date.now();
    this._timer       = null;
    this._lagTimer    = null;
    this._bot         = null;
    this._packetHandler = null;
    this._onWarn      = (opts && opts.onWarn) || (() => {});
    this._stats       = { warnings: 0, lagWarnings: 0, packets: 0 };
  }

  attach(bot) {
    if (this._bot) this.detach();
    this._bot = bot;
    this._lastPacket = Date.now();
    this._lastLagMark = Date.now();

    // Mineflayer exposes the underlying minecraft-protocol client
    if (bot && bot._client && typeof bot._client.on === 'function') {
      this._packetHandler = () => {
        this._lastPacket = Date.now();
        this._stats.packets++;
      };
      bot._client.on('packet', this._packetHandler);
    }

    // Packet-silence watchdog
    this._timer = setInterval(() => {
      const since = Date.now() - this._lastPacket;
      if (since > PACKET_WARN_MS) {
        this._stats.warnings++;
        this._onWarn({
          kind: 'packet_silence',
          msSilent: since,
          message: 'No server packet for ' + Math.round(since / 1000) + 's — connection may be lagging'
        });
      }
    }, CHECK_EVERY);

    // Event-loop lag watchdog (compares actual vs scheduled tick time)
    const tick = () => {
      if (!this._lagTimer) return; // detached
      const now = Date.now();
      const drift = now - this._lastLagMark - CHECK_EVERY;
      if (drift > LAG_WARN_MS) {
        this._stats.lagWarnings++;
        this._onWarn({
          kind: 'event_loop_lag',
          driftMs: drift,
          message: 'Event loop blocked for ~' + drift + 'ms (target tick: ' + CHECK_EVERY + 'ms)'
        });
      }
      this._lastLagMark = now;
      this._lagTimer = setTimeout(tick, CHECK_EVERY);
    };
    this._lagTimer = setTimeout(tick, CHECK_EVERY);
  }

  detach() {
    if (this._timer)    { clearInterval(this._timer);  this._timer = null; }
    if (this._lagTimer) { clearTimeout(this._lagTimer); this._lagTimer = null; }
    if (this._bot && this._bot._client && this._packetHandler) {
      try { this._bot._client.removeListener('packet', this._packetHandler); } catch (_) {}
    }
    this._packetHandler = null;
    this._bot = null;
  }

  msSinceLastPacket() {
    return Date.now() - this._lastPacket;
  }

  getStats() {
    return Object.assign({}, this._stats, {
      msSinceLastPacket: this.msSinceLastPacket(),
      attached: !!this._bot
    });
  }
}

module.exports = { KeepAlive, PACKET_WARN_MS, LAG_WARN_MS };
