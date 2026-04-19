class ProcessManager {
  constructor(options) {
    const input = options || {};
    this.botManager = input.botManager;
    this.server = input.server || null;
    this.closeWeb = typeof input.closeWeb === 'function' ? input.closeWeb : null;
    this.restartTimer = null;
    this.restartTimes = [];
    this.started = false;
    this.shuttingDown = false;
    this.totalRestarts = 0;
    this.restartDisabled = false;
    this.maxRestarts = toPositiveInteger(process.env.BOT_MAX_RESTARTS, 5);
    this.restartWindowMs = toPositiveInteger(process.env.BOT_RESTART_WINDOW_MS, 300000);
    this.restartDelayMs = toPositiveInteger(process.env.BOT_RESTART_DELAY_MS || process.env.BOT_RECONNECT_DELAY_MS, 10000);
    if (this.botManager) {
      this.botManager.processManager = this;
    }
  }

  start() {
    if (this.started) return;
    this.started = true;

    if (this.botManager) {
      this.botManager.on('botError', (err) => {
        this.requestBotRestart('bot error', err);
      });
    }

    process.on('uncaughtException', (err) => {
      this.handleRuntimeFailure('uncaught exception', err);
    });

    process.on('unhandledRejection', (err) => {
      this.handleRuntimeFailure('unhandled rejection', err);
    });
  }

  startBotFromEnvironment() {
    if (!this.botManager) return;
    try {
      this.botManager.createBot();
    } catch (err) {
      this.requestBotRestart('startup failure', err);
    }
  }

  handleRuntimeFailure(reason, err) {
    if (this.shuttingDown) return;
    const message = err && err.message ? err.message : String(err);
    if (this.botManager) {
      this.botManager.log('Runtime failure captured: ' + reason + ' - ' + message);
    }
    this.requestBotRestart(reason, err);
  }

  requestBotRestart(reason, err) {
    if (this.shuttingDown || !this.botManager || this.restartTimer) return;
    if (!this.botManager.bot && !this.botManager.lastConnectionOptions) return;

    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((at) => now - at <= this.restartWindowMs);
    if (this.restartTimes.length >= this.maxRestarts) {
      this.restartDisabled = true;
      this.botManager.shouldReconnect = false;
      this.botManager.stop();
      this.botManager.log('Bot restart limit reached; manual start required');
      return;
    }

    this.restartTimes.push(now);
    this.totalRestarts += 1;
    const message = err && err.message ? err.message : String(err || reason);
    this.botManager.log('Restarting bot after ' + reason + ': ' + message);
    const options = this.botManager.lastConnectionOptions ? Object.assign({}, this.botManager.lastConnectionOptions) : undefined;
    this.botManager.stopBotOnly();

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shuttingDown) return;
      try {
        this.botManager.createBot(options);
      } catch (restartErr) {
        this.requestBotRestart('restart failure', restartErr);
      }
    }, this.restartDelayMs);
  }

  shutdown(done) {
    this.shuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.botManager) {
      this.botManager.stop();
    }
    if (this.closeWeb) {
      this.closeWeb(() => done && done());
      return;
    }
    if (this.server && this.server.listening) {
      this.server.close(() => done && done());
      return;
    }
    if (done) done();
  }

  getRuntimeSummary() {
    return {
      status: this.shuttingDown ? 'shutting_down' : this.restartDisabled ? 'manual_start_required' : this.restartTimer ? 'restarting' : 'running',
      restartCount: this.totalRestarts,
      recentRestarts: this.restartTimes.filter((at) => Date.now() - at <= this.restartWindowMs).length,
      maxRestarts: this.maxRestarts
    };
  }
}

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

module.exports = ProcessManager;