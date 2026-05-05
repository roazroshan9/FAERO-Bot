const EventEmitter = require('events');
const decisionEngine = require('./decisionEngine');

class Brain extends EventEmitter {
  constructor(ctx) {
    super();
    this.ctx = ctx;

    this.interval = null;
    const configuredTick = Number(process.env.BOT_TICK_MS || ctx.tickMs || 10000);
    this.tickMs = Number.isFinite(configuredTick) && configuredTick >= 5000 ? configuredTick : 10000;
    this.enabled = true;

    this.isRunning = false;
    this.lastDecision = null;
    this.lastDecisionTime = 0;

    this.ctx.lastEconomyCheck = 0;
  }

  start() {
    if (this.interval) return;

    this.enabled = true;

    this.interval = setInterval(() => {
      this.tick().catch((err) => this.emit('error', err));
    }, this.tickMs);

    this.tick().catch((err) => this.emit('error', err));
  }

  stop() {
    this.enabled = false;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  interrupt() {
    this.isRunning = false;
  }

  triggerTick() {
    this.tick().catch((err) => this.emit('error', err));
  }

  setTickMs(ms) {
    const safe = Number.isFinite(ms) && ms >= 5000 ? ms : 10000;
    this.tickMs = safe;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = setInterval(() => {
        this.tick().catch((err) => this.emit('error', err));
      }, this.tickMs);
    }
  }

  async tick() {
    if (!this.enabled || this.isRunning) return;

    const bot = this.ctx.bot;
    if (!bot || !bot.entity) return;

    this.isRunning = true;

    try {
      const snapshot = decisionEngine.think(bot);

      const decision = decisionEngine.decide(this.ctx, snapshot);

      const now = Date.now();
      const decisionKey = [
        decision.type,
        decision.reason,
        decision.target && decision.target.name,
        decision.ore && decision.ore.name
      ].filter(Boolean).join(':');
      if (
        decisionKey === this.lastDecision &&
        now - this.lastDecisionTime < 10000
      ) {
        return;
      }

      this.lastDecision = decisionKey;
      this.lastDecisionTime = now;

      this.emit('thought', { snapshot, decision });

      await decisionEngine.act(this.ctx, decision);

    } catch (err) {
      console.log("Brain error:", err.message);
      this.emit('error', err);
    } finally {
      this.isRunning = false;
    }
  }
}

module.exports = Brain;