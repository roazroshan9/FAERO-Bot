const EventEmitter = require('events');

const STATES = {
  IDLE: 'idle',
  MINING: 'mining',
  FIGHTING: 'fighting',
  ESCAPING: 'escaping',
  FOLLOWING: 'following',
  PAYING: 'paying',
  COMMAND: 'command'
};

class StateManager extends EventEmitter {
  constructor() {
    super();
    this.state = STATES.IDLE;
    this.reason = 'boot';
    this.updatedAt = Date.now();
  }

  setState(state, reason) {
    if (!Object.values(STATES).includes(state)) {
      throw new Error('Invalid bot state: ' + state);
    }
    const previous = this.state;
    this.state = state;
    this.reason = reason || '';
    this.updatedAt = Date.now();
    this.emit('change', {
      previous,
      state,
      reason: this.reason,
      updatedAt: this.updatedAt
    });
  }

  getState() {
    return {
      state: this.state,
      reason: this.reason,
      updatedAt: this.updatedAt
    };
  }

  isBusy() {
    return this.state !== STATES.IDLE;
  }

  reset(reason) {
    this.setState(STATES.IDLE, reason || 'reset');
  }
}

module.exports = {
  StateManager,
  STATES
};