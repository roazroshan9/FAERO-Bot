'use strict';

/**
 * FAERO Mobile — Cordova/nodejs-mobile bridge + UI logic
 * ───────────────────────────────────────────────────────
 * Communicates with the Node.js backend in www/nodejs-project/index.js
 * via the nodejs-mobile-cordova plugin channel.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }); }
  catch (_) { return ''; }
}

// ── Foreground service helpers ────────────────────────────────────────────────

var _fgRunning = false;

function fgStart(status) {
  if (typeof FaeroForeground === 'undefined') return;
  FaeroForeground.start(status || {});
  _fgRunning = true;
  setBgIndicator(true);
}

function fgUpdate(status) {
  if (!_fgRunning || typeof FaeroForeground === 'undefined') return;
  FaeroForeground.update(status || {});
}

function fgStop() {
  if (typeof FaeroForeground === 'undefined') return;
  FaeroForeground.stop();
  _fgRunning = false;
  setBgIndicator(false);
}

function setBgIndicator(active) {
  var dot = document.getElementById('bgDot');
  if (!dot) return;
  dot.style.display = active ? 'inline-flex' : 'none';
}

// ── Cordova deviceready ───────────────────────────────────────────────────────

document.addEventListener('deviceready', onDeviceReady, false);

function onDeviceReady() {
  setBootStatus('Cordova ready — starting Node.js engine…');

  // Start the Node.js backend
  nodejs.start('index.js', function (err) {
    if (err) {
      setBootStatus('ERROR: ' + err.message);
      console.error('nodejs.start error:', err);
      return;
    }
    setBootStatus('Node.js engine started — waiting for FAERO…');
  });

  // Listen for messages from Node.js backend
  nodejs.channel.setListener(onNodeMessage);
}

// ── Node.js message handler ───────────────────────────────────────────────────

var _botOnline = false;

function onNodeMessage(rawMsg) {
  var msg;
  try { msg = JSON.parse(rawMsg); }
  catch (_) { appendLog('RAW: ' + rawMsg); return; }

  var type = msg.type;
  var data = msg.data;

  switch (type) {

    case 'ready':
      setBootStatus(data.message || 'Backend ready');
      setTimeout(showApp, 600);
      appendLog('Node.js ' + (data.node || '') + ' — backend ready');
      break;

    case 'status':
      applyStatus(data);
      break;

    case 'log':
      appendLog(data.message || JSON.stringify(data));
      break;

    case 'chat':
      appendChat(data.username, data.message, 'user');
      break;

    case 'bot_chat':
      appendChat(data.username || 'faero', data.message, 'bot');
      break;

    case 'error':
      appendLog('ERROR: ' + (data.message || JSON.stringify(data)));
      showError(data.message || 'Unknown error');
      break;

    case 'pong':
      appendLog('Pong — ' + fmtTime(data.at));
      break;

    default:
      appendLog('[' + type + '] ' + JSON.stringify(data));
  }
}

// ── Send message to Node.js backend ──────────────────────────────────────────

function sendToNode(type, data) {
  try {
    nodejs.channel.send(JSON.stringify({ type, data: data || {} }));
  } catch (err) {
    appendLog('Bridge error: ' + err.message);
  }
}

// ── Boot screen ───────────────────────────────────────────────────────────────

function setBootStatus(msg) {
  var el = document.getElementById('bootStatus');
  if (el) el.textContent = msg;
}

function showApp() {
  var boot = document.getElementById('bootScreen');
  var app  = document.getElementById('app');
  if (boot) { boot.style.opacity = '0'; setTimeout(function () { boot.style.display = 'none'; }, 500); }
  if (app)  app.style.display = 'flex';
}

// ── Status application ────────────────────────────────────────────────────────

function applyStatus(s) {
  if (!s) return;
  var wasOnline = _botOnline;
  _botOnline = !!s.connected;

  var dot   = document.getElementById('connDot');
  var label = document.getElementById('connLabel');
  if (dot)   { dot.className   = 'conn-dot ' + (_botOnline ? 'online' : 'offline'); }
  if (label) { label.textContent = _botOnline ? 'ONLINE' : 'OFFLINE'; }

  // ── Foreground service notification sync ─────────────────────────────
  var fgPayload = {
    state:     s.state     || 'IDLE',
    health:    s.health    !== undefined ? s.health : 20,
    food:      s.food      !== undefined ? s.food   : 20,
    server:    s.server    || '',
    dimension: s.dimension || 'overworld'
  };
  if (_botOnline && !_fgRunning) {
    fgStart(fgPayload);                   // first connect → start the service
  } else if (_botOnline && _fgRunning) {
    fgUpdate(fgPayload);                  // already running → refresh notification
  } else if (!_botOnline && _fgRunning) {
    fgStop();                             // disconnect → dismiss notification
  }

  setText('sState',  s.state      || '—');
  setText('sHealth', s.health     !== undefined ? s.health : '—');
  setText('sFood',   s.food       !== undefined ? s.food   : '—');
  setText('sDim',    s.dimension  || '—');
  setText('sUser',   s.username   || '—');
  if (s.position) {
    setText('sPosX', Math.round(s.position.x));
    setText('sPosY', Math.round(s.position.y));
    setText('sPosZ', Math.round(s.position.z));
  }

  // Health/food bars
  setBar('barHealth', 'barHealthVal', s.health, 20);
  setBar('barFood',   'barFoodVal',   s.food,   20);

  // Enable / disable controls
  var btnConnect    = document.getElementById('btnConnect');
  var btnDisconnect = document.getElementById('btnDisconnect');
  if (btnConnect)    btnConnect.disabled    = _botOnline;
  if (btnDisconnect) btnDisconnect.disabled = !_botOnline;

  document.querySelectorAll('.cmd-btn').forEach(function (b) {
    b.disabled = !_botOnline;
  });
}

function setText(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setBar(barId, valId, current, max) {
  var pct = Math.min(100, Math.round(((current || 0) / max) * 100));
  var el  = document.getElementById(barId);
  if (el) el.style.width = pct + '%';
  var ve  = document.getElementById(valId);
  if (ve) ve.textContent = (current || 0) + '/' + max;
}

// ── Log feed ──────────────────────────────────────────────────────────────────

var _logFeed = document.getElementById('logFeed');
var MAX_LOGS = 200;

function appendLog(msg) {
  if (!_logFeed) _logFeed = document.getElementById('logFeed');
  if (!_logFeed) return;

  var row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML = '<span class="log-time">' + fmtTime(new Date().toISOString()) + '</span>' +
                  '<span class="log-msg">'  + esc(msg) + '</span>';
  _logFeed.appendChild(row);

  var rows = _logFeed.querySelectorAll('.log-row');
  if (rows.length > MAX_LOGS) _logFeed.removeChild(_logFeed.firstChild);
  _logFeed.scrollTop = _logFeed.scrollHeight;
}

// ── Chat log ──────────────────────────────────────────────────────────────────

var _chatLog = document.getElementById('chatLog');

function appendChat(username, message, role) {
  if (!_chatLog) _chatLog = document.getElementById('chatLog');
  if (!_chatLog) return;
  var cls  = role === 'bot' ? 'chat-bot' : 'chat-user';
  var row  = document.createElement('div');
  row.className = 'chat-log-row';
  row.innerHTML = '<span class="' + cls + '">&lt;' + esc(username) + '&gt;</span> ' + esc(message);
  _chatLog.appendChild(row);
  _chatLog.scrollTop = _chatLog.scrollHeight;
}

// ── Error display ─────────────────────────────────────────────────────────────

function showError(msg) {
  var el = document.getElementById('connectError');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(function () { el.style.display = 'none'; }, 5000);
}

// ── Tab switching ─────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(function (tab) {
  tab.addEventListener('click', function () {
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
    document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
    tab.classList.add('active');
    var panel = document.getElementById('tab-' + tab.getAttribute('data-tab'));
    if (panel) panel.classList.add('active');
  });
});

// ── Connect button ────────────────────────────────────────────────────────────

document.getElementById('btnConnect').addEventListener('click', function () {
  var host     = (document.getElementById('inHost').value     || '').trim();
  var port     = parseInt(document.getElementById('inPort').value, 10) || 25565;
  var username = (document.getElementById('inUsername').value || '').trim() || 'faero_bot';
  var password = (document.getElementById('inPassword').value || '').trim();
  var version  = (document.getElementById('inVersion').value  || '').trim();

  if (!host) { showError('Server host is required.'); return; }

  document.getElementById('connectError').style.display = 'none';
  sendToNode('connect', { host, port, username, password, version: version || false });
  appendLog('Connecting to ' + host + ':' + port + ' as ' + username + '…');
});

// ── Disconnect button ─────────────────────────────────────────────────────────

document.getElementById('btnDisconnect').addEventListener('click', function () {
  sendToNode('disconnect', {});
  appendLog('Disconnecting…');
});

// ── Command buttons ───────────────────────────────────────────────────────────

document.querySelectorAll('.cmd-btn').forEach(function (btn) {
  btn.disabled = true; // enabled once bot is online
  btn.addEventListener('click', function () {
    var cmd  = btn.getAttribute('data-cmd');
    var args = {};
    try { args = JSON.parse(btn.getAttribute('data-args') || '{}'); } catch (_) {}
    sendToNode('command', { command: cmd, args });
    appendLog('> ' + cmd);
  });
});

// ── Chat input ────────────────────────────────────────────────────────────────

var inChat     = document.getElementById('inChat');
var btnSendChat = document.getElementById('btnSendChat');

function sendChatMsg() {
  var msg = (inChat.value || '').trim();
  if (!msg) return;
  inChat.value = '';
  sendToNode('command', { command: 'chat', args: { message: msg } });
  appendChat('you', msg, 'user');
}

btnSendChat.addEventListener('click', sendChatMsg);
inChat.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') sendChatMsg();
});

// ── Clear logs ────────────────────────────────────────────────────────────────

document.getElementById('btnClearLogs').addEventListener('click', function () {
  var lf = document.getElementById('logFeed');
  if (lf) lf.innerHTML = '';
});

// ── Status polling fallback ───────────────────────────────────────────────────

setInterval(function () {
  sendToNode('status', {});
}, 10000);
