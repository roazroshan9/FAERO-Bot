const EventEmitter = require('events');

class TaskQueue extends EventEmitter {
  constructor(options) {
    super();
    this.queue = [];
    this.running = false;
    this.currentTask = null;
    this.paused = false;
    this.timeoutMs = options && options.timeoutMs ? options.timeoutMs : 120000;
  }

  push(name, task, options) {
    if (typeof task !== 'function') {
      throw new Error('Task must be a function');
    }
    const item = {
      id: Date.now() + '-' + Math.random().toString(16).slice(2),
      name: name || 'task',
      task,
      priority: options && options.priority ? options.priority : 0,
      createdAt: Date.now()
    };
    this.queue.push(item);
    this.queue.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    this.emit('queued', this.snapshot());
    this.run().catch((err) => this.emit('error', err));
    return item.id;
  }

  clear() {
    this.queue = [];
    this.emit('cleared', this.snapshot());
  }

  pause() {
    this.paused = true;
    this.emit('paused', this.snapshot());
  }

  resume() {
    this.paused = false;
    this.emit('resumed', this.snapshot());
    this.run().catch((err) => this.emit('error', err));
  }

  async run() {
    if (this.running || this.paused) return;
    this.running = true;
    while (this.queue.length > 0 && !this.paused) {
      const item = this.queue.shift();
      this.currentTask = item;
      this.emit('started', this.snapshot());
      try {
        await this.runWithTimeout(item.task, this.timeoutMs);
        this.emit('finished', this.snapshot());
      } catch (err) {
        this.emit('taskError', {
          task: item.name,
          error: err && err.message ? err.message : String(err)
        });
      } finally {
        this.currentTask = null;
      }
    }
    this.running = false;
    this.emit('idle', this.snapshot());
  }

  runWithTimeout(task, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Task timed out after ' + timeoutMs + 'ms'));
      }, timeoutMs);

      Promise.resolve()
        .then(task)
        .then((result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  snapshot() {
    return {
      running: this.running,
      paused: this.paused,
      currentTask: this.currentTask ? this.currentTask.name : null,
      pending: this.queue.map((item) => item.name)
    };
  }
}

module.exports = TaskQueue;