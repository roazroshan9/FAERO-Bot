'use strict';

/**
 * MongoDB connection layer for FAERO.
 *
 * Behaviour
 *   - Reads MONGODB_URI from process.env (loaded from .env or Replit Secrets).
 *   - If URI is missing OR the connection fails within CONNECT_TIMEOUT_MS,
 *     falls back to "Local-Only Mode" — the rest of the bot keeps running,
 *     but persistence helpers become no-ops.
 *   - All schema modules call `isReady()` before issuing queries.
 */

const mongoose = require('mongoose');

const CONNECT_TIMEOUT_MS = 5000;

let _state = {
  ready: false,
  reason: 'not_initialized',
  uri: null
};

const _listeners = new Set();

function _emit() {
  for (const fn of _listeners) {
    try { fn(getState()); } catch (_) {}
  }
}

function onChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function getState() {
  return Object.assign({}, _state);
}

function isReady() {
  return _state.ready && mongoose.connection.readyState === 1;
}

async function connect(logger) {
  const log = typeof logger === 'function' ? logger : () => {};
  const uri = (process.env.MONGODB_URI || '').trim();

  if (!uri) {
    _state = { ready: false, reason: 'no_uri', uri: null };
    log('[mongo] MONGODB_URI not set — running in Local-Only Mode');
    _emit();
    return false;
  }

  _state.uri = _redact(uri);

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
      socketTimeoutMS: 20000,
      maxPoolSize: 5
    });
    _state = { ready: true, reason: 'connected', uri: _state.uri };
    log('[mongo] Connected — persistence enabled (' + _state.uri + ')');

    mongoose.connection.on('disconnected', () => {
      _state.ready = false;
      _state.reason = 'disconnected';
      log('[mongo] Connection lost — falling back to Local-Only Mode');
      _emit();
    });
    mongoose.connection.on('reconnected', () => {
      _state.ready = true;
      _state.reason = 'connected';
      log('[mongo] Reconnected — persistence re-enabled');
      _emit();
    });

    _emit();
    return true;
  } catch (err) {
    _state = { ready: false, reason: 'connect_failed:' + (err && err.message ? err.message : String(err)), uri: _state.uri };
    log('[mongo] Connection failed — Local-Only Mode (' + _state.reason + ')');
    _emit();
    return false;
  }
}

async function disconnect() {
  try { await mongoose.disconnect(); } catch (_) {}
  _state = { ready: false, reason: 'disconnected', uri: _state.uri };
  _emit();
}

function _redact(uri) {
  try {
    const u = new URL(uri);
    if (u.password) u.password = '***';
    if (u.username) u.username = u.username.slice(0, 2) + '***';
    return u.toString();
  } catch {
    return 'mongodb://[redacted]';
  }
}

module.exports = {
  connect,
  disconnect,
  isReady,
  getState,
  onChange
};
