'use strict';

/**
 * FAERO — Anti-Detection Module (modules/antiDetection.js)
 *
 * Makes the bot behave more like a real human player to avoid server bans.
 *
 *  1. jitter(minMs, maxMs)
 *       Random delay utility. Await between any two actions so they never
 *       fire at perfectly regular machine intervals.
 *
 *  2. smoothLook(bot, yaw, pitch, opts)
 *       Interpolates head rotation with an ease-in-out curve instead of
 *       snapping instantly to a target — natural raycasting.
 *
 *  3. IdleBehaviour
 *       When the bot has no active task it randomly looks around, sneaks,
 *       jumps, or takes a small step — mimicking a human waiting.
 *
 *  4. AntiAFK
 *       Runs a subtle movement pattern every ~55 s to prevent kick timers.
 *       The interval is randomised ±8 s so it never triggers at a fixed beat.
 *
 * Integration (see core/botManager.js):
 *   const antiDetection = require('../modules/antiDetection');
 *
 *   // on spawn:
 *   antiDetection.attach(bot, {
 *     onLog:  (msg)  => this.log(msg),
 *     isIdle: ()     => !this.stateManager.isBusy()
 *   });
 *
 *   // on end / stop:
 *   antiDetection.detach();
 *
 *   // wrap any action pair with jitter:
 *   await antiDetection.jitter(200, 600);
 *
 *   // smooth look before targeting an entity:
 *   await antiDetection.smoothLook(bot, targetYaw, targetPitch);
 */

// ── 1. Jitter ─────────────────────────────────────────────────────────────────

/**
 * Resolves after a uniformly random delay between minMs and maxMs.
 * Drop-in replacement for a fixed `await wait(N)` call.
 *
 * @param  {number} [minMs=150]
 * @param  {number} [maxMs=500]
 * @returns {Promise<void>}
 */
function jitter(minMs, maxMs) {
  const lo = (typeof minMs === 'number' && minMs >= 0) ? minMs : 150;
  const hi = (typeof maxMs === 'number' && maxMs >= lo) ? maxMs : lo + 350;
  const ms = Math.floor(Math.random() * (hi - lo + 1)) + lo;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 2. Smooth Look ────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;

/**
 * Compute the shortest signed angular distance from `from` to `to` (radians).
 * Result is in [-π, π].
 */
function _angleDiff(from, to) {
  let d = ((to - from) % TWO_PI + TWO_PI) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  return d;
}

/**
 * Rotate the bot's head smoothly from its current orientation to (yaw, pitch)
 * using an ease-in-out cubic curve so the movement looks natural.
 *
 * @param {object} bot          - mineflayer bot instance
 * @param {number} targetYaw    - target yaw in radians
 * @param {number} targetPitch  - target pitch in radians (clamped to ±π/2)
 * @param {object} [opts]
 * @param {number} [opts.steps=8]   - interpolation steps (more = smoother)
 * @param {number} [opts.stepMs=45] - milliseconds between each step
 * @returns {Promise<void>}
 */
async function smoothLook(bot, targetYaw, targetPitch, opts) {
  if (!bot || !bot.entity) return;

  const steps  = Math.max(2, (opts && opts.steps)  || 8);
  const stepMs = Math.max(10, (opts && opts.stepMs) || 45);

  const startYaw   = bot.entity.yaw;
  const startPitch = bot.entity.pitch;
  const dYaw       = _angleDiff(startYaw, targetYaw);
  const dPitch     = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, targetPitch)) - startPitch;

  for (let i = 1; i <= steps; i++) {
    if (!bot.entity) break;

    const t    = i / steps;
    // Ease-in-out cubic: smooth start and smooth end
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    const yaw   = startYaw   + dYaw   * ease;
    const pitch = Math.max(-Math.PI / 2,
                   Math.min( Math.PI / 2, startPitch + dPitch * ease));

    try {
      await bot.look(yaw, pitch, false);
    } catch (_) {
      break;
    }

    if (i < steps) {
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }
}

// ── 3. Idle Behaviour ─────────────────────────────────────────────────────────

const IDLE_MIN_INTERVAL_MS = 9_000;   // fastest idle trigger
const IDLE_MAX_INTERVAL_MS = 24_000;  // slowest idle trigger

// Cumulative probability thresholds (must sum to 1.0)
const IDLE_P_LOOK       = 0.45;  // glance around
const IDLE_P_SNEAK      = 0.25;  // sneak pulse    (cumulative 0.70)
const IDLE_P_MICRO_MOVE = 0.20;  // micro step     (cumulative 0.90)
// remainder 0.10  => jump

class IdleBehaviour {
  /**
   * @param {object}   opts
   * @param {object}   opts.bot    - mineflayer bot
   * @param {function} [opts.onLog]  - log callback (msg: string) => void
   * @param {function} [opts.isIdle] - fn() → bool; true = bot is free to act
   */
  constructor(opts) {
    this._bot    = opts.bot;
    this._log    = opts.onLog  || function () {};
    this._isIdle = opts.isIdle || function () { return true; };
    this._timer  = null;
    this._active = false;
  }

  start() {
    if (this._active) return;
    this._active = true;
    this._schedule();
    this._log('[anti-detect] idle behaviour started');
  }

  stop() {
    this._active = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _schedule() {
    if (!this._active) return;
    const delay = IDLE_MIN_INTERVAL_MS +
                  Math.floor(Math.random() * (IDLE_MAX_INTERVAL_MS - IDLE_MIN_INTERVAL_MS));
    this._timer = setTimeout(() => this._tick(), delay);
  }

  async _tick() {
    if (!this._active) return;
    const bot = this._bot;

    // Only act when bot is alive and has nothing to do
    if (!bot || !bot.entity || !this._isIdle()) {
      this._schedule();
      return;
    }

    const roll = Math.random();
    try {
      if (roll < IDLE_P_LOOK) {
        await this._doLook(bot);
      } else if (roll < IDLE_P_LOOK + IDLE_P_SNEAK) {
        await this._doSneak(bot);
      } else if (roll < IDLE_P_LOOK + IDLE_P_SNEAK + IDLE_P_MICRO_MOVE) {
        await this._doMicroMove(bot);
      } else {
        await this._doJump(bot);
      }
    } catch (_) {
      // Bot may have disconnected mid-action; silently skip
    }

    this._schedule();
  }

  // ── Individual idle actions ────────────────────────────────────────────────

  async _doLook(bot) {
    const curYaw   = bot.entity.yaw;
    const curPitch = bot.entity.pitch;

    // Glance up to ±70° horizontally and ±25° vertically from current view
    const targetYaw   = curYaw + (Math.random() - 0.5) * 2.4;
    const targetPitch = Math.max(-0.8, Math.min(0.5,
                          curPitch + (Math.random() - 0.5) * 0.9));

    this._log('[anti-detect] idle: glance');
    await smoothLook(bot, targetYaw, targetPitch, { steps: 7, stepMs: 48 });

    // Pause as if actually looking at something
    await jitter(400, 1100);

    // Drift partway back — not a perfect return (humans don't do that)
    if (!bot.entity) return;
    const returnYaw   = curYaw + (Math.random() - 0.5) * 0.5;
    const returnPitch = curPitch + (Math.random() - 0.5) * 0.2;
    await smoothLook(bot, returnYaw, returnPitch, { steps: 5, stepMs: 52 });
  }

  async _doSneak(bot) {
    const dur = 400 + Math.floor(Math.random() * 900); // 400–1300 ms
    this._log('[anti-detect] idle: sneak ' + dur + 'ms');
    bot.setControlState('sneak', true);
    await jitter(dur, dur + 120);
    bot.setControlState('sneak', false);
  }

  async _doJump(bot) {
    this._log('[anti-detect] idle: jump');
    bot.setControlState('jump', true);
    await jitter(75, 150);
    bot.setControlState('jump', false);
  }

  async _doMicroMove(bot) {
    const dirs   = ['forward', 'back', 'left', 'right'];
    const dir    = dirs[Math.floor(Math.random() * dirs.length)];
    const dur    = 100 + Math.floor(Math.random() * 220); // 100–320 ms
    const retDir = { forward: 'back', back: 'forward', left: 'right', right: 'left' }[dir];

    this._log('[anti-detect] idle: micro-step ' + dir);

    bot.setControlState(dir, true);
    await jitter(dur, dur + 80);
    bot.setControlState(dir, false);

    await jitter(180, 450);

    // Return step is slightly shorter so the bot drifts a little — natural
    bot.setControlState(retDir, true);
    await jitter(Math.floor(dur * 0.6), Math.floor(dur * 0.85));
    bot.setControlState(retDir, false);
  }
}

// ── 4. Anti-AFK ───────────────────────────────────────────────────────────────

const AFK_BASE_INTERVAL_MS = 52_000; // fires well before typical 60 s AFK kick
const AFK_JITTER_MS        =  9_000; // ±9 s so it never lands on a fixed beat
const AFK_PATTERNS         = ['look_sweep', 'step_and_back', 'sneak_pulse', 'look_down_up'];

class AntiAFK {
  /**
   * @param {object}   opts
   * @param {object}   opts.bot   - mineflayer bot
   * @param {function} [opts.onLog] - log callback
   */
  constructor(opts) {
    this._bot    = opts.bot;
    this._log    = opts.onLog || function () {};
    this._timer  = null;
    this._active = false;
  }

  start() {
    if (this._active) return;
    this._active = true;
    this._schedule();
    this._log('[anti-detect] anti-AFK started');
  }

  stop() {
    this._active = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _schedule() {
    if (!this._active) return;
    const delay = AFK_BASE_INTERVAL_MS +
                  Math.floor((Math.random() - 0.5) * 2 * AFK_JITTER_MS);
    this._timer = setTimeout(() => this._tick(), delay);
  }

  async _tick() {
    if (!this._active) return;
    const bot = this._bot;

    if (!bot || !bot.entity) {
      this._schedule();
      return;
    }

    const pattern = AFK_PATTERNS[Math.floor(Math.random() * AFK_PATTERNS.length)];
    try {
      switch (pattern) {
        case 'look_sweep':    await this._sweep(bot);        break;
        case 'step_and_back': await this._stepAndBack(bot);  break;
        case 'sneak_pulse':   await this._sneakPulse(bot);   break;
        case 'look_down_up':  await this._lookDownUp(bot);   break;
      }
      this._log('[anti-detect] anti-AFK: ' + pattern);
    } catch (_) {
      // Bot disconnected or pathfinder interrupted
    }

    this._schedule();
  }

  // ── AFK patterns ──────────────────────────────────────────────────────────

  async _sweep(bot) {
    // Slow horizontal pan left, then right, then settle
    const originYaw = bot.entity.yaw;
    const pitch     = bot.entity.pitch;
    await smoothLook(bot, originYaw + 0.55, pitch, { steps: 12, stepMs: 58 });
    await jitter(250, 700);
    await smoothLook(bot, originYaw - 0.35, pitch, { steps: 12, stepMs: 58 });
    await jitter(200, 500);
    await smoothLook(bot, originYaw + (Math.random() - 0.5) * 0.3, pitch, { steps: 6, stepMs: 52 });
  }

  async _stepAndBack(bot) {
    // Nudge forward then return — just enough to reset AFK timer
    bot.setControlState('forward', true);
    await jitter(130, 230);
    bot.setControlState('forward', false);
    await jitter(350, 800);
    bot.setControlState('back', true);
    await jitter(110, 190);
    bot.setControlState('back', false);
  }

  async _sneakPulse(bot) {
    bot.setControlState('sneak', true);
    await jitter(380, 900);
    bot.setControlState('sneak', false);
  }

  async _lookDownUp(bot) {
    // Glance down at feet, pause, look back up — "checking inventory feel"
    const originPitch = bot.entity.pitch;
    await smoothLook(bot, bot.entity.yaw, 1.1, { steps: 9, stepMs: 55 });
    await jitter(500, 1100);
    await smoothLook(bot, bot.entity.yaw, originPitch, { steps: 9, stepMs: 55 });
  }
}

// ── Public attach / detach API ────────────────────────────────────────────────

let _idle = null;
let _afk  = null;

/**
 * Attach all anti-detection systems to a live mineflayer bot instance.
 * Call this once per bot session, after the bot has spawned.
 *
 * @param {object}   bot
 * @param {object}   [opts]
 * @param {function} [opts.onLog]   - log callback (msg: string) => void
 * @param {function} [opts.isIdle]  - fn() → bool; true when bot is free
 * @param {boolean}  [opts.idle=true]  - enable idle behaviour
 * @param {boolean}  [opts.afk=true]   - enable anti-AFK
 */
function attach(bot, opts) {
  detach(); // clean up any previous session

  const onLog  = (opts && opts.onLog)  || function () {};
  const isIdle = (opts && opts.isIdle) || function () { return true; };

  if (!opts || opts.idle !== false) {
    _idle = new IdleBehaviour({ bot, onLog, isIdle });
    _idle.start();
  }

  if (!opts || opts.afk !== false) {
    _afk = new AntiAFK({ bot, onLog });
    _afk.start();
  }

  onLog('[anti-detect] attached — idle=' + (!opts || opts.idle !== false) +
        ', afk=' + (!opts || opts.afk !== false));
}

/**
 * Stop all anti-detection timers. Call when the bot disconnects.
 */
function detach() {
  if (_idle) { _idle.stop(); _idle = null; }
  if (_afk)  { _afk.stop();  _afk  = null; }
}

module.exports = {
  jitter,
  smoothLook,
  attach,
  detach,
  IdleBehaviour,
  AntiAFK
};
