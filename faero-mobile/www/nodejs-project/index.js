'use strict';

/**
 * FAERO nodejs-mobile entry point — LIVE BOT
 * ───────────────────────────────────────────
 * Runs the real FAERO BotManager inside the Android APK.
 * All source files (core/, modules/, ai/, lib/, config/, plugins/, commands/)
 * are bundled alongside this file by nodejs-mobile-cordova.
 *
 * Bridge protocol — JSON strings over the nodejs-mobile channel:
 *   WebView → Node : { type, data }
 *   Node → WebView : { type, data }
 *
 * ── Inbound message types ──────────────────────────────────────────────────
 *   connect    { host, port, username, password, version }
 *   disconnect
 *   command    { command, args }        → botManager.runWebCommand()
 *   status                             → push current status
 *   ai_mode    { enabled: bool }       → botManager.setAiMode()
 *   low_power  { enabled: bool }       → botManager.setLowPowerMode()
 *   ping                               → pong
 *
 * ── Outbound message types ─────────────────────────────────────────────────
 *   ready      { message, node, at }
 *   status     { connected, username, health, food, state, position,
 *                dimension, server, aiMode, lowPower }
 *   log        { at, message }
 *   chat       { username, message }
 *   error      { message [, stack] }
 *   pong       { at }
 */

// ── Load .env file if present (host: /data/data/com.faero.bot/files/) ─────────
try {
  const path = require('path');
  require('dotenv').config({
    path: path.join(process.cwd(), '.env')
  });
} catch (_) {}

// ── Cordova bridge (falls back to process IPC for local testing) ──────────────
let cordova;
try {
  cordova = require('cordova-bridge');
} catch (_) {
  cordova = {
    channel: {
      on:   (evt, fn) => process.on('message', fn),
      send: (msg)     => process.send && process.send(msg)
    },
    app: { datadir: () => process.cwd() }
  };
}

/**
 * Low-level send — safe to call before botManager is initialised.
 * @param {string} type
 * @param {*}      data
 */
function send(type, data) {
  try {
    cordova.channel.send(JSON.stringify({ type, data }));
  } catch (_) {}
}

// ── Status normaliser ─────────────────────────────────────────────────────────
// Translates BotManager.getStatus() into the compact shape the mobile UI needs.
function normalizeStatus(s) {
  const stateObj = (s && s.state && typeof s.state === 'object') ? s.state : {};
  const stateStr = String(stateObj.state || 'offline').toUpperCase();
  const conn     = (s && s.connection) || null;
  const server   = conn ? (conn.host + ':' + conn.port) : '';

  // Dimension comes from the live Mineflayer bot object (not in getStatus())
  let dimension = 'overworld';
  try {
    const dim = botManager.bot && botManager.bot.game && botManager.bot.game.dimension;
    if (dim) dimension = String(dim).replace(/^minecraft:/, '').replace(/_/g, ' ');
  } catch (_) {}

  return {
    connected:  !!(s && s.running),
    username:   (s && s.username)  || null,
    health:     (s && s.health  != null) ? s.health  : 20,
    food:       (s && s.hunger  != null) ? s.hunger  : 20,
    state:      stateStr,
    position:   (s && s.position)  || null,
    dimension,
    server,
    aiMode:     !!(s && s.aiModeEnabled),
    lowPower:   !!(s && s.lowPowerMode)
  };
}

// ── Real FAERO BotManager ─────────────────────────────────────────────────────
const BotManager = require('./core/botManager');
const botManager = new BotManager();

// ── Rich bridge (uses botManager — must be declared after it) ─────────────────
const bridge = {
  send,
  pushStatus() {
    send('status', normalizeStatus(botManager.getStatus()));
  }
};

// ── Wire BotManager events → WebView ─────────────────────────────────────────

// Log entries (includes errors, state changes, combat events, etc.)
botManager.on('log', (entry) => bridge.send('log', entry));

// Bot status changes (health, spawn, disconnect, state transitions)
botManager.on('bot', () => bridge.pushStatus());

// State transitions — also forward as log so they show in the Logs tab
botManager.on('state', (st) => {
  bridge.send('log', {
    at:      new Date().toISOString(),
    message: '[state] \u2192 ' + st.state.toUpperCase() +
             (st.reason ? ' (' + st.reason + ')' : '')
  });
});

// Wire in-game chat forwarding.
// botManager.bot is null until a Minecraft connection succeeds; we attach
// the chat listener lazily each time a new bot object is created.
let _chatBridged = false;
botManager.on('bot', () => {
  const bot = botManager.bot;
  if (bot && !_chatBridged) {
    _chatBridged = true;
    bot.on('chat', (username, message) => {
      // Don't echo the bot's own messages
      if (username !== bot.username) {
        bridge.send('chat', { username, message });
      }
    });
    // Reset flag when the connection ends so the next bot gets it too
    bot.once('end', () => { _chatBridged = false; });
  }
});

// ── MongoDB — optional, graceful fallback ─────────────────────────────────────
try {
  const mongo = require('./lib/persistence/mongo');
  mongo.connect((msg) => send('log', { at: new Date().toISOString(), message: msg }));
} catch (err) {
  send('log', { at: new Date().toISOString(), message: '[mongo] skipped: ' + err.message });
}

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

    // ── Connect to Minecraft server ──────────────────────────────────────────
    case 'connect': {
      try {
        const d = data || {};
        await botManager.createBot({
          host:     String(d.host     || 'localhost').trim(),
          port:     Number(d.port)    || 25565,
          username: String(d.username || 'faero').trim(),
          // Use 'microsoft' auth if a password was supplied, otherwise offline
          auth:     (d.password && d.password.length) ? 'microsoft' : 'offline',
          password: d.password || undefined,
          version:  d.version  || undefined
        });
        bridge.pushStatus();
      } catch (err) {
        bridge.send('error', {
          message: 'Connect failed: ' + (err && err.message ? err.message : String(err))
        });
      }
      break;
    }

    // ── Hard stop (shouldReconnect = false) ──────────────────────────────────
    case 'disconnect': {
      botManager.stop();
      bridge.pushStatus();
      break;
    }

    // ── Web command (follow, stop, mine, attack, go, pay …) ──────────────────
    case 'command': {
      try {
        const d = data || {};
        botManager.runWebCommand(d.command, d.args || {});
      } catch (err) {
        bridge.send('error', {
          message: 'Command error: ' + (err && err.message ? err.message : String(err))
        });
      }
      break;
    }

    // ── Status poll ──────────────────────────────────────────────────────────
    case 'status': {
      bridge.pushStatus();
      break;
    }

    // ── Toggle AI brain ──────────────────────────────────────────────────────
    case 'ai_mode': {
      botManager.setAiMode(!!(data && data.enabled));
      bridge.pushStatus();
      break;
    }

    // ── Toggle low-power mode ────────────────────────────────────────────────
    case 'low_power': {
      botManager.setLowPowerMode(!!(data && data.enabled));
      bridge.pushStatus();
      break;
    }

    // ── Latency check ────────────────────────────────────────────────────────
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
  message: 'FAERO Bot backend started',
  at:      new Date().toISOString(),
  node:    process.version
});

// Status heartbeat — keeps the mobile UI and foreground notification current
setInterval(() => bridge.pushStatus(), 5000);

// ── Global error guards ───────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  bridge.send('error', {
    message: 'Uncaught: ' + (err && err.message ? err.message : String(err)),
    stack:   err && err.stack ? err.stack : undefined
  });
});

process.on('unhandledRejection', (reason) => {
  bridge.send('error', {
    message: 'Unhandled rejection: ' + String(reason)
  });
});
