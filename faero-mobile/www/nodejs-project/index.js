'use strict';

/**
 * FAERO nodejs-mobile entry point
 * ────────────────────────────────
 * This file is the backend process that nodejs-mobile-cordova launches
 * inside the Android APK.  It runs in a real Node.js runtime (not a
 * WebView) so every npm package in package.json works here.
 *
 * Communication with the Cordova WebView uses the built-in bridge:
 *   cordova.channel.send(string)     → sends message TO the WebView
 *   cordova.channel.on('message', …) → receives messages FROM the WebView
 *
 * HOW TO WIRE IN YOUR FAERO FILES
 * ────────────────────────────────
 * 1. Paste your bot source files alongside this index.js
 *    (core/, modules/, ai/, lib/, etc.)
 * 2. Replace the PASTE YOUR FILES comment below with:
 *       const BotManager = require('./core/botManager');
 * 3. The rest of this bridge code stays the same — it already handles
 *    connect/disconnect/command messages from the mobile UI.
 */

// ── Bridge setup ──────────────────────────────────────────────────────────────
let cordova;
try {
  cordova = require('cordova-bridge');
} catch (_) {
  // Running outside Cordova (e.g. local test with `node index.js`)
  cordova = {
    channel: {
      on:   (evt, fn) => process.on('message', fn),
      send: (msg)     => process.send && process.send(msg)
    },
    app: { datadir: () => process.cwd() }
  };
}

// ── Bot manager placeholder ───────────────────────────────────────────────────
// PASTE YOUR FILES: replace this stub with your real BotManager import.
// e.g.  const BotManager = require('./core/botManager');
//
// For now a lightweight stub is used so the bridge initialises cleanly.

class BotManagerStub {
  constructor() {
    this._connected = false;
    this._username  = null;
    this._host      = '';
    this._logs      = [];
  }

  async connect(opts) {
    this._connected = true;
    this._username  = opts.username || 'faero';
    this._host      = (opts.host || 'localhost') + ':' + (opts.port || 25565);
    this._log('Connected as ' + this._username + ' to ' + this._host);
  }

  disconnect() {
    this._connected = false;
    this._log('Disconnected');
  }

  runCommand(cmd, args) {
    this._log('Command: ' + cmd + (args ? ' ' + JSON.stringify(args) : ''));
  }

  getStatus() {
    return {
      connected:  this._connected,
      username:   this._username,
      health:     20,
      food:       20,
      state:      this._connected ? 'IDLE' : 'OFFLINE',
      position:   null,
      dimension:  'overworld',
      server:     this._host
    };
  }

  _log(msg) {
    const entry = { at: new Date().toISOString(), message: msg };
    this._logs.push(entry);
    if (this._logs.length > 200) this._logs.shift();
    bridge.send('log', entry);
  }
}

const botManager = new BotManagerStub();
// When you paste your real BotManager, wire its events to bridge.send():
//   botManager.on('log',    (e) => bridge.send('log', e));
//   botManager.on('bot',    (s) => bridge.send('status', s));
//   botManager.on('chat',   (c) => bridge.send('chat', c));

// ── Bridge helpers ────────────────────────────────────────────────────────────

const bridge = {
  /**
   * Send a typed message to the WebView.
   * @param {string} type  — event name the WebView listens for
   * @param {*}      data  — any JSON-serialisable payload
   */
  send(type, data) {
    try {
      cordova.channel.send(JSON.stringify({ type, data }));
    } catch (_) {}
  },

  /** Push current bot status to the WebView. */
  pushStatus() {
    this.send('status', botManager.getStatus());
  }
};

// ── Incoming messages from WebView ────────────────────────────────────────────

cordova.channel.on('message', async (rawMsg) => {
  let msg;
  try {
    msg = typeof rawMsg === 'string' ? JSON.parse(rawMsg) : rawMsg;
  } catch (_) {
    bridge.send('error', { message: 'Invalid JSON from WebView: ' + String(rawMsg) });
    return;
  }

  const { type, data } = msg || {};

  switch (type) {

    case 'connect': {
      try {
        await botManager.connect({
          host:     data.host     || 'localhost',
          port:     Number(data.port)     || 25565,
          username: data.username || 'faero',
          password: data.password || '',
          version:  data.version  || false
        });
        bridge.pushStatus();
      } catch (err) {
        bridge.send('error', { message: 'Connect failed: ' + err.message });
      }
      break;
    }

    case 'disconnect': {
      botManager.disconnect();
      bridge.pushStatus();
      break;
    }

    case 'command': {
      try {
        botManager.runCommand(data.command, data.args || {});
      } catch (err) {
        bridge.send('error', { message: 'Command error: ' + err.message });
      }
      break;
    }

    case 'status': {
      bridge.pushStatus();
      break;
    }

    case 'ping': {
      bridge.send('pong', { at: new Date().toISOString() });
      break;
    }

    default:
      bridge.send('error', { message: 'Unknown message type: ' + type });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────

bridge.send('ready', {
  message: 'FAERO Node.js backend started',
  at:      new Date().toISOString(),
  node:    process.version
});

// Push status every 5 s while running
setInterval(() => bridge.pushStatus(), 5000);

process.on('uncaughtException', (err) => {
  bridge.send('error', { message: 'Uncaught: ' + err.message, stack: err.stack });
});
