if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

const socket = io({
  transports: ['websocket'],
  reconnectionAttempts: Infinity,
  reconnectionDelay: 2000,
  reconnectionDelayMax: 10000,
  timeout: 10000
});

const MAX_LOG_ENTRIES = 50;
let _savedWaypoint = null;
let _statusRefreshTimer = null;

const els = {
  running: document.getElementById('running'),
  health: document.getElementById('health'),
  hunger: document.getElementById('hunger'),
  position: document.getElementById('position'),
  state: document.getElementById('state'),
  logs: document.getElementById('logs'),
  chatMessages: document.getElementById('chatMessages'),
  chatForm: document.getElementById('chatForm'),
  chatInput: document.getElementById('chatInput'),
  thought: document.getElementById('thought'),
  host: document.getElementById('host'),
  port: document.getElementById('port'),
  username: document.getElementById('username'),
  auth: document.getElementById('auth'),
  proxy: document.getElementById('proxy'),
  connectionReadout: document.getElementById('connectionReadout'),
  unlockButton: document.getElementById('unlockButton'),
  lockScreen: document.getElementById('lock-screen'),
  mainContent: document.getElementById('main-content'),
  passInput: document.getElementById('pass-input'),
  errorMsg: document.getElementById('error-msg'),
  cpuUsage: document.getElementById('cpuUsage'),
  ramUsage: document.getElementById('ramUsage'),
  runtimeStatus: document.getElementById('runtimeStatus'),
  restartCount: document.getElementById('restartCount')
};

let renderedLogCount = 0;
let metricsTimer = null;
let panelUnlocked = false;
let lowPowerMode = false;
let aiModeEnabled = false;
let _metricsLastRender = 0;
const METRICS_THROTTLE_MS = 3000;
let _userTier = 0;
let _userIdentity = '';
const TIER_ADMIN = 2;
const TIER_OWNER = 3;

const aiModeToggle = document.getElementById('aiModeToggle');
aiModeToggle.addEventListener('click', () => {
  aiModeEnabled = !aiModeEnabled;
  socket.emit('set_ai_mode', { enabled: aiModeEnabled });
  updateAiModeDisplay(aiModeEnabled);
});

function updateAiModeDisplay(enabled) {
  aiModeToggle.textContent = 'AI Mode: ' + (enabled ? 'ON' : 'OFF');
  aiModeToggle.className = enabled ? 'ai-mode-on' : 'ai-mode-off';
  const pill = document.getElementById('aiModePill');
  if (pill) {
    pill.textContent = 'AI: ' + (enabled ? 'ON' : 'OFF');
    pill.classList.toggle('ai-active', enabled);
  }
}

const lowPowerToggle = document.getElementById('lowPowerToggle');
lowPowerToggle.addEventListener('click', () => {
  lowPowerMode = !lowPowerMode;
  socket.emit('set_low_power_mode', { enabled: lowPowerMode });
  updateLowPowerButton(lowPowerMode);
});

const forceCleanupBtn = document.getElementById('forceCleanup');
forceCleanupBtn.addEventListener('click', () => {
  socket.emit('force_cleanup');
  forceCleanupBtn.textContent = 'Cleaning...';
  forceCleanupBtn.disabled = true;
  setTimeout(() => {
    forceCleanupBtn.textContent = 'Force Cleanup';
    forceCleanupBtn.disabled = false;
  }, 1500);
});

function updateLowPowerButton(enabled) {
  lowPowerToggle.textContent = 'Low Power Mode: ' + (enabled ? 'ON' : 'OFF');
  lowPowerToggle.className = enabled ? 'low-power-on' : 'low-power-off';
}

els.unlockButton.addEventListener('click', unlockPanel);
els.passInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') unlockPanel();
});
document.getElementById('identity-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') document.getElementById('pass-input').focus();
});

document.getElementById('start').addEventListener('click', () => {
  const proxyVal = els.proxy.value.trim();
  const connection = {
    host: els.host.value.trim() || undefined,
    port: els.port.value ? Number(els.port.value) : undefined,
    username: els.username.value.trim() || undefined,
    auth: els.auth.value.trim() || undefined,
    proxy: proxyVal || undefined
  };
  appendLog({ at: new Date().toISOString(), message: 'Connecting to ' + (connection.host || 'localhost') + ':' + (connection.port || 25565) + ' as ' + (connection.username || 'AI_Bot') + (proxyVal ? ' via proxy' : '') });
  socket.emit('start', connection);
});

document.getElementById('stop').addEventListener('click', () => {
  socket.emit('stop');
});

document.querySelectorAll('[data-command]').forEach((button) => {
  button.addEventListener('click', () => {
    socket.emit('command', {
      command: button.dataset.command,
      args: {}
    });
  });
});

document.querySelectorAll('[data-move]').forEach((button) => {
  const direction = button.dataset.move;
  const startMove = (event) => {
    event.preventDefault();
    socket.emit('move', { direction });
  };
  const stopMove = (event) => {
    event.preventDefault();
    if (direction !== 'stop') socket.emit('move', { direction: 'stop' });
  };
  button.addEventListener('pointerdown', startMove);
  button.addEventListener('pointerup', stopMove);
  button.addEventListener('pointerleave', stopMove);
  button.addEventListener('pointercancel', stopMove);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    if (direction === 'stop') socket.emit('move', { direction: 'stop' });
  });
});

document.getElementById('attack').addEventListener('click', () => {
  socket.emit('command', {
    command: 'attack',
    args: { target: document.getElementById('target').value.trim() }
  });
});

document.getElementById('go').addEventListener('click', () => {
  socket.emit('command', {
    command: 'go',
    args: {
      x: document.getElementById('x').value,
      y: document.getElementById('y').value,
      z: document.getElementById('z').value
    }
  });
});

document.getElementById('mineBlock').addEventListener('click', () => {
  const amountVal = document.getElementById('mineAmount').value;
  socket.emit('command', {
    command: 'mine_block',
    args: {
      block: document.getElementById('block').value.trim(),
      amount: amountVal ? Number(amountVal) : undefined
    }
  });
});

document.getElementById('pay').addEventListener('click', () => {
  socket.emit('command', {
    command: 'pay',
    args: {
      player: document.getElementById('payPlayer').value.trim(),
      amount: document.getElementById('payAmount').value
    }
  });
});

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    if (els.running.textContent === 'OFFLINE') {
      appendLog({ at: new Date().toISOString(), message: 'Bot is offline. Connect first.' });
      return;
    }
    socket.emit('bot_action', { action: button.getAttribute('data-action') });
  });
});

els.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = els.chatInput.value.trim();
  if (!message) return;
  socket.emit('chatMessage', message);
  els.chatInput.value = '';
  els.chatInput.focus();
});

socket.on('connect', () => {
  renderedLogCount = 0;
});

socket.on('status', renderStatus);
socket.on('log', appendLog);
socket.on('chatLog', appendChatLog);
socket.on('thought', renderThought);
socket.on('errorMessage', (message) => {
  appendLog({ at: new Date().toISOString(), message: 'Error: ' + message });
  appendChatLog({ username: 'bot', message });
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    socket.disconnect();
    if (_statusRefreshTimer) { clearInterval(_statusRefreshTimer); _statusRefreshTimer = null; }
  } else {
    socket.connect();
    if (panelUnlocked) {
      fetchRuntimeMetrics();
      startStatusRefresh();
    }
  }
});

async function unlockPanel() {
  const key = els.passInput.value;
  try {
    const res = await fetch('/bot-api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const data = await res.json();
    if (data.ok) {
      _userIdentity = (document.getElementById('identity-input').value || '').trim();
      els.lockScreen.classList.add('hidden');
      els.mainContent.classList.add('unlocked');
      els.passInput.value = '';
      document.getElementById('identity-input').value = '';
      els.errorMsg.classList.remove('visible');
      panelUnlocked = true;
      startRuntimeMetrics();
      startStatusRefresh();
      fetchConfig();
      if (_userIdentity) {
        try {
          const tierRes = await fetch('/bot-api/roles/tier?id=' + encodeURIComponent(_userIdentity), { cache: 'no-store' });
          const tierData = await tierRes.json();
          _userTier = tierData.tier || 0;
        } catch (_e) {
          _userTier = 0;
        }
      }
      const rolePanel = document.getElementById('rolePanel');
      if (_userTier >= TIER_ADMIN && rolePanel) {
        rolePanel.style.display = '';
        fetchRoles();
      }
    } else {
      els.errorMsg.classList.add('visible');
      els.passInput.value = '';
      const lockBox = document.querySelector('.lock-box');
      lockBox.classList.remove('shake');
      void lockBox.offsetWidth;
      lockBox.classList.add('shake');
      lockBox.addEventListener('animationend', () => lockBox.classList.remove('shake'), { once: true });
    }
  } catch (_err) {
    els.errorMsg.classList.add('visible');
    els.passInput.value = '';
  }
}

function startStatusRefresh() {
  if (_statusRefreshTimer) return;
  _statusRefreshTimer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const res = await fetch('/bot-api/status', { cache: 'no-store' });
      if (!res.ok) throw new Error('status fetch failed');
      renderStatus(await res.json());
    } catch (_e) {
    }
  }, 3000);
}

function startRuntimeMetrics() {
  if (metricsTimer) return;
  fetchRuntimeMetrics();
  metricsTimer = setInterval(() => {
    if (!document.hidden) fetchRuntimeMetrics();
  }, 45000);
}

async function fetchRuntimeMetrics() {
  try {
    const response = await fetch('/bot-api/runtime', { cache: 'no-store' });
    if (!response.ok) throw new Error('metrics unavailable');
    renderRuntimeMetrics(await response.json());
  } catch (err) {
    renderRuntimeMetrics(null);
  }
}

function renderRuntimeMetrics(metrics) {
  const now = Date.now();
  if (now - _metricsLastRender < METRICS_THROTTLE_MS) return;
  _metricsLastRender = now;

  const cpuBox = els.cpuUsage.parentElement;
  const ramBox = els.ramUsage.parentElement;

  if (!metrics) {
    els.cpuUsage.textContent = '-';
    els.ramUsage.textContent = '-';
    els.runtimeStatus.textContent = 'unavailable';
    cpuBox.classList.remove('runtime-stat-alert');
    ramBox.classList.remove('runtime-stat-alert');
    return;
  }

  const cpuPct = Number(metrics.cpuPercent) || 0;
  const ramMb  = Number(metrics.ramMb)      || 0;
  const cpuAlert = cpuPct > 80;
  const ramAlert = ramMb  > 300;

  cpuBox.classList.toggle('runtime-stat-alert', cpuAlert);
  ramBox.classList.toggle('runtime-stat-alert', ramAlert);

  els.cpuUsage.textContent = (cpuAlert ? '⚠ ' : '') + value(metrics.cpuPercent) + '%';
  els.ramUsage.textContent = (ramAlert ? '⚠ ' : '') + value(metrics.ramMb) + ' MB';
  els.runtimeStatus.textContent = formatRuntimeStatus(metrics.status);
  els.restartCount.textContent = value(metrics.restartCount);
}

function fmtMs(ms) {
  if (ms == null || isNaN(ms)) return '-';
  if (ms >= 60000 && ms % 60000 === 0) return (ms / 60000) + 'm';
  if (ms >= 1000 && ms % 1000 === 0) return (ms / 1000) + 's';
  return ms + 'ms';
}

async function fetchConfig() {
  try {
    const response = await fetch('/bot-api/config', { cache: 'no-store' });
    if (!response.ok) throw new Error('config unavailable');
    renderConfig(await response.json());
  } catch {
    renderConfig(null);
  }
}

function renderConfig(cfg) {
  function set(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  if (!cfg) {
    ['cfg-tickMs','cfg-mobScanMs','cfg-oreScanMs','cfg-cpuLimit','cfg-dangerRange',
     'cfg-dangerActionMs','cfg-cmdCooldown','cfg-survivalMs','cfg-resourceMs',
     'cfg-maxMemMb','cfg-maxRestarts','cfg-memCleanupMs','cfg-autoCleanupMs']
      .forEach(id => set(id, 'N/A'));
    return;
  }
  set('cfg-tickMs',         fmtMs(cfg.botTickMs));
  set('cfg-mobScanMs',      fmtMs(cfg.mobScanIntervalMs));
  set('cfg-oreScanMs',      fmtMs(cfg.oreScanIntervalMs));
  set('cfg-cpuLimit',       cfg.cpuLimitPercent + '%');
  set('cfg-dangerRange',    cfg.dangerWatchRange + ' blk');
  set('cfg-dangerActionMs', fmtMs(cfg.dangerActionIntervalMs));
  set('cfg-cmdCooldown',    fmtMs(cfg.commandCooldownMs));
  set('cfg-survivalMs',     fmtMs(cfg.survivalActionIntervalMs));
  set('cfg-resourceMs',     fmtMs(cfg.resourceActionIntervalMs));
  set('cfg-maxMemMb',       cfg.maxMemoryMb + ' MB');
  set('cfg-maxRestarts',    String(cfg.maxRestarts));
  set('cfg-memCleanupMs',   fmtMs(cfg.memoryCleanupIntervalMs));
  set('cfg-autoCleanupMs',  fmtMs(cfg.autoCleanupIntervalMs));
}

document.getElementById('refreshConfig').addEventListener('click', () => {
  if (!panelUnlocked) return;
  fetchConfig();
});

function clearSkeletons(ddEl) {
  const sk = ddEl.querySelector('.skeleton-line');
  if (sk) sk.remove();
}

function renderStatus(status) {
  if (typeof status.aiModeEnabled === 'boolean' && status.aiModeEnabled !== aiModeEnabled) {
    aiModeEnabled = status.aiModeEnabled;
    updateAiModeDisplay(aiModeEnabled);
  }
  if (typeof status.lowPowerMode === 'boolean' && status.lowPowerMode !== lowPowerMode) {
    lowPowerMode = status.lowPowerMode;
    updateLowPowerButton(lowPowerMode);
  }
  [els.health, els.hunger, els.position, els.state].forEach(clearSkeletons);
  els.running.textContent = status.running ? 'ONLINE' : 'OFFLINE';
  els.running.classList.toggle('online', Boolean(status.running));
  els.health.textContent = value(status.health);
  els.hunger.textContent = value(status.hunger);
  if (status.position) _currentBotPosition = status.position;
  els.position.textContent = status.position ? status.position.x + ', ' + status.position.y + ', ' + status.position.z : '-';
  els.state.textContent = status.state ? status.state.reason || status.state.state : 'idle';
  els.connectionReadout.textContent = status.running && status.username ? 'Connected as ' + status.username : 'Awaiting connection';
  if (Array.isArray(status.logs) && status.logs.length > 0) {
    if (status.logs.length < renderedLogCount) {
      els.logs.innerHTML = '';
      renderedLogCount = 0;
    }
    if (status.logs.length !== renderedLogCount) {
      const atBottom = isLogsAtBottom();
      status.logs.slice(renderedLogCount).forEach(appendLogLineOnly);
      renderedLogCount = status.logs.length;
      if (atBottom) els.logs.scrollTop = els.logs.scrollHeight;
    }
  }
  renderThought({
    decision: {
      type: status.state ? status.state.state : 'idle',
      reason: status.state ? status.state.reason : 'waiting'
    },
    snapshot: {
      health: status.health,
      hunger: status.hunger,
      position: status.position,
      queue: status.queue
    }
  });
}

function renderThought(payload) {
  const decision = payload && payload.decision ? payload.decision : { type: 'idle', reason: 'waiting' };
  const snapshot = payload && payload.snapshot ? payload.snapshot : {};
  els.thought.textContent = [
    'state: ' + value(decision.type),
    'reason: ' + value(decision.reason),
    'health: ' + value(snapshot.health),
    'hunger: ' + value(snapshot.hunger),
    'position: ' + formatPosition(snapshot.position),
    'queue: ' + formatQueue(snapshot.queue)
  ].join('\n');
}

function isLogsAtBottom() {
  return els.logs.scrollHeight - els.logs.scrollTop - els.logs.clientHeight <= 48;
}

function appendLog(entry) {
  renderedLogCount += 1;
  const atBottom = isLogsAtBottom();
  appendLogLineOnly(entry);
  if (atBottom) els.logs.scrollTop = els.logs.scrollHeight;
}

function classifyLog(message) {
  const m = String(message || '').toLowerCase();
  if (/error|fail|kick|disconnect|crash|died|exception/.test(m)) return 'log-msg--error';
  if (/warn|alert|monitor|timeout|exceeded|limit|memory/.test(m)) return 'log-msg--warning';
  return 'log-msg--success';
}

function appendLogLineOnly(entry) {
  const line = document.createElement('div');
  line.className = 'log-line';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(entry.at).toLocaleTimeString();
  const msg = document.createElement('span');
  msg.className = classifyLog(entry.message);
  msg.textContent = entry.message;
  line.appendChild(time);
  line.appendChild(msg);
  els.logs.appendChild(line);
  while (els.logs.children.length > MAX_LOG_ENTRIES) {
    els.logs.removeChild(els.logs.firstChild);
  }
}

function appendChatLog(data) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  const user = document.createElement('span');
  user.className = data.username === 'bot' ? 'chat-user bot-user' : 'chat-user';
  user.textContent = '[' + data.username + ']:';
  const msg = document.createElement('span');
  msg.className = 'chat-message';
  msg.textContent = ' ' + data.message;
  line.appendChild(user);
  line.appendChild(msg);
  els.chatMessages.appendChild(line);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function formatPosition(position) {
  if (!position) return '-';
  return position.x + ', ' + position.y + ', ' + position.z;
}

function formatQueue(queue) {
  if (!queue) return '-';
  if (queue.currentTask) return queue.currentTask;
  if (Array.isArray(queue.pending) && queue.pending.length) return queue.pending.join(', ');
  return queue.running ? 'running' : 'idle';
}

function value(input) {
  return input === null || input === undefined || input === '' ? '-' : String(input);
}

function formatRuntimeStatus(status) {
  return String(status || 'running').replace(/_/g, ' ');
}

socket.on('inventory', renderInventory);

// ── Waypoints panel ─────────────────────────────────────────────────────
const wpNameInput = document.getElementById('wpName');
const wpSetBtn    = document.getElementById('wpSetBtn');
const wpRefreshBtn= document.getElementById('wpRefreshBtn');
const wpListEl    = document.getElementById('wpList');
const wpStatusEl  = document.getElementById('wpStatus');
const wpErrorEl   = document.getElementById('wpError');

function wpShowError(payload) {
  if (!wpErrorEl) return;
  const err = payload && payload.error ? payload.error : null;
  if (!err) { wpErrorEl.style.display = 'none'; wpErrorEl.textContent = ''; return; }
  wpErrorEl.innerHTML =
    '<div class="wp-error-title">▣ ' + (err.title || 'Waypoint Error') + '</div>' +
    '<div class="wp-error-msg">' + (err.message || 'Unknown error.') + '</div>';
  wpErrorEl.style.display = 'block';
  setTimeout(() => { wpErrorEl.style.display = 'none'; }, 6000);
}

async function wpFetch(url, opts) {
  const r = await fetch(url, opts);
  let body = null;
  try { body = await r.json(); } catch (_) {}
  if (!r.ok) wpShowError(body);
  return { ok: r.ok, body };
}

async function loadWaypoints() {
  const { ok, body } = await wpFetch('/bot-api/waypoints');
  if (!ok || !body || !body.ok) {
    wpStatusEl.textContent = 'offline';
    wpListEl.innerHTML = '<div class="wp-empty">Persistence offline — waypoints unavailable.</div>';
    return;
  }
  const list = body.waypoints || [];
  wpStatusEl.textContent = list.length + ' saved · owner: ' + body.owner;
  if (!list.length) {
    wpListEl.innerHTML = '<div class="wp-empty">No waypoints saved yet. Position the bot and click Set.</div>';
    return;
  }
  wpListEl.innerHTML = list.map(w => {
    const safe = String(w.label).replace(/[^a-z0-9_-]/gi, '');
    return '<div class="wp-row">' +
      '<div class="wp-row-info">' +
        '<span class="wp-row-name">' + safe + '</span>' +
        '<span class="wp-row-coords">X ' + Math.round(w.x) + '  Y ' + Math.round(w.y) + '  Z ' + Math.round(w.z) + '</span>' +
      '</div>' +
      '<div class="wp-row-actions">' +
        '<button class="wp-go-btn"  data-wp="' + safe + '">Go</button>' +
        '<button class="wp-del-btn" data-wp="' + safe + '">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');
  wpListEl.querySelectorAll('.wp-go-btn').forEach(b =>
    b.addEventListener('click', () => wpGo(b.dataset.wp)));
  wpListEl.querySelectorAll('.wp-del-btn').forEach(b =>
    b.addEventListener('click', () => wpDelete(b.dataset.wp)));
}

async function wpSet() {
  const name = (wpNameInput.value || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(name)) {
    wpShowError({ error: { title: 'Invalid Name', message: 'Name must be 1-32 chars: a-z, 0-9, _ or -.' } });
    return;
  }
  const { ok } = await wpFetch('/bot-api/waypoints', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  if (ok) { wpNameInput.value = ''; loadWaypoints(); }
}

async function wpGo(name) {
  await wpFetch('/bot-api/waypoints/' + encodeURIComponent(name) + '/go', { method: 'POST' });
}

async function wpDelete(name) {
  const { ok } = await wpFetch('/bot-api/waypoints/' + encodeURIComponent(name), { method: 'DELETE' });
  if (ok) loadWaypoints();
}

if (wpSetBtn)     wpSetBtn.addEventListener('click', wpSet);
if (wpRefreshBtn) wpRefreshBtn.addEventListener('click', loadWaypoints);
if (wpNameInput)  wpNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') wpSet(); });
loadWaypoints();
setInterval(loadWaypoints, 15000);


// ── Death Log ──────────────────────────────────────────────────────────────────
const deathListEl     = document.getElementById('deathList');
const deathCountEl    = document.getElementById('deathCount');
const deathRefreshBtn = document.getElementById('deathRefreshBtn');

async function loadDeaths() {
  let body = null;
  try {
    const r = await fetch('/bot-api/deaths');
    if (r.ok) body = await r.json();
  } catch (_) {}

  if (!body || !body.ok) {
    if (deathListEl) deathListEl.innerHTML = '<div class="wp-empty">Unable to load death log.</div>';
    return;
  }

  const list = body.deaths || [];
  if (deathCountEl) deathCountEl.textContent = body.offline ? 'offline' : list.length + ' recorded';

  if (!list.length) {
    if (deathListEl) deathListEl.innerHTML = '<div class="wp-empty">No deaths recorded yet.</div>';
    return;
  }

  if (deathListEl) {
    deathListEl.innerHTML = list.map(d => {
      const ts   = new Date(d.at).toLocaleString();
      const flag = d.recovered
        ? '<span class="death-recovered">recovered</span>'
        : '<span class="death-pending">pending</span>';
      const cause = String(d.cause || 'unknown').replace(/</g, '&lt;');
      return '<div class="death-row">' +
        '<div class="death-row-info">' +
          '<span class="death-coords">X ' + Math.round(d.x) + '  Y ' + Math.round(d.y) + '  Z ' + Math.round(d.z) + '</span>' +
          '<span class="death-meta">Cause: ' + cause + ' · ' + ts + '</span>' +
        '</div>' +
        '<div class="death-row-status">' + flag + '</div>' +
      '</div>';
    }).join('');
  }
}

if (deathRefreshBtn) deathRefreshBtn.addEventListener('click', loadDeaths);
loadDeaths();
setInterval(loadDeaths, 30000);


const invOfflineMsg = document.getElementById('invOfflineMsg');
const invContainer = document.getElementById('invContainer');
const invItemCount = document.getElementById('invItemCount');

function renderInventory(data) {
  if (!data || !data.ok) {
    invOfflineMsg.style.display = 'block';
    invContainer.classList.add('inv-hidden');
    invItemCount.textContent = '—';
    return;
  }

  invOfflineMsg.style.display = 'none';
  invContainer.classList.remove('inv-hidden');

  const slotMap = {};
  (data.slots || []).forEach((item) => { slotMap[item.slot] = item; });

  const totalItems = data.slots.reduce((sum, item) => sum + item.count, 0);
  invItemCount.textContent = data.slots.length + ' types · ' + totalItems + ' items';

  buildSlots(document.getElementById('invArmor'), [5, 6, 7, 8], slotMap, 'inv-armor-slot');
  buildSlots(document.getElementById('invMain'), range(9, 35), slotMap);
  buildSlots(document.getElementById('invHotbar'), range(36, 44), slotMap, 'inv-hotbar-slot');
  buildSlots(document.getElementById('invOffhand'), [45], slotMap);
}

function range(start, end) {
  const arr = [];
  for (let i = start; i <= end; i++) arr.push(i);
  return arr;
}

function buildSlots(container, slotNums, slotMap, extraClass) {
  container.innerHTML = '';
  slotNums.forEach((num) => {
    container.appendChild(makeSlot(slotMap[num] || null, num, extraClass));
  });
}

function makeSlot(item, slotNum, extraClass) {
  const el = document.createElement('div');
  el.className = 'inv-slot' + (item ? ' inv-slot-filled' : '') + (extraClass ? ' ' + extraClass : '');
  el.dataset.slot = slotNum;

  if (item) {
    const img = document.createElement('img');
    img.className = 'inv-item-icon';
    img.alt = item.displayName;
    img.src = 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/1.20.1/assets/minecraft/textures/item/' + item.name + '.png';
    img.onerror = function() {
      this.onerror = null;
      this.src = 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/1.20.1/assets/minecraft/textures/block/' + item.name + '.png';
      this.onerror = function() {
        this.style.display = 'none';
        const abbr = el.querySelector('.inv-abbr');
        if (abbr) abbr.style.display = 'flex';
      };
    };

    const abbr = document.createElement('div');
    abbr.className = 'inv-abbr';
    abbr.style.display = 'none';
    abbr.style.background = itemColor(item.name);
    abbr.textContent = itemAbbr(item.name);

    const count = document.createElement('span');
    count.className = 'inv-count';
    if (item.count > 1) count.textContent = item.count;

    const tip = document.createElement('div');
    tip.className = 'inv-tip';
    tip.textContent = item.displayName + (item.count > 1 ? ' ×' + item.count : '');

    el.appendChild(img);
    el.appendChild(abbr);
    el.appendChild(count);
    el.appendChild(tip);
  }

  return el;
}

function itemAbbr(name) {
  return name.split('_').map((w) => w[0] ? w[0].toUpperCase() : '').join('').slice(0, 3) || '?';
}

function itemColor(name) {
  if (/sword|axe|pickaxe|shovel|hoe/.test(name)) return 'rgba(68,136,255,0.7)';
  if (/helmet|chestplate|leggings|boots/.test(name)) return 'rgba(170,170,200,0.7)';
  if (/diamond/.test(name)) return 'rgba(85,255,255,0.7)';
  if (/gold|golden/.test(name)) return 'rgba(255,170,0,0.7)';
  if (/iron/.test(name)) return 'rgba(170,170,170,0.7)';
  if (/netherite/.test(name)) return 'rgba(90,60,50,0.7)';
  if (/apple|bread|steak|beef|carrot|potato|chicken|fish|food|mushroom/.test(name)) return 'rgba(136,255,68,0.7)';
  if (/wood|log|plank|oak|spruce|birch|jungle|acacia|dark/.test(name)) return 'rgba(196,162,103,0.7)';
  if (/stone|cobble|granite|diorite|andesite/.test(name)) return 'rgba(136,136,136,0.7)';
  if (/arrow|bow/.test(name)) return 'rgba(200,153,68,0.7)';
  if (/potion|bottle/.test(name)) return 'rgba(153,68,255,0.7)';
  if (/emerald/.test(name)) return 'rgba(0,255,136,0.7)';
  if (/redstone|tnt|fire/.test(name)) return 'rgba(255,50,50,0.7)';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const r = 80 + ((h >> 16) & 0x7f);
  const g = 80 + ((h >> 8) & 0x7f);
  const b = 80 + (h & 0x7f);
  return 'rgba(' + r + ',' + g + ',' + b + ',0.7)';
}

let _currentBotPosition = null;

document.getElementById('retryConnect').addEventListener('click', async () => {
  const btn = document.getElementById('retryConnect');
  btn.disabled = true;
  btn.classList.add('retrying');
  btn.textContent = 'Retrying…';
  try {
    const res = await fetch('/bot-api/reconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await res.json();
    appendLog({ at: new Date().toISOString(), message: data.ok ? 'Reconnect requested.' : 'Reconnect failed: ' + (data.error || 'unknown error') });
  } catch (err) {
    appendLog({ at: new Date().toISOString(), message: 'Retry error: ' + err.message });
  } finally {
    btn.disabled = false;
    btn.classList.remove('retrying');
    btn.textContent = 'Retry Connection';
  }
});

document.getElementById('saveWaypoint').addEventListener('click', () => {
  if (!_currentBotPosition) {
    appendLog({ at: new Date().toISOString(), message: 'No position available — connect the bot first.' });
    return;
  }
  _savedWaypoint = { x: _currentBotPosition.x, y: _currentBotPosition.y, z: _currentBotPosition.z };
  const readout = document.getElementById('waypointReadout');
  readout.textContent = 'WP: ' + Math.round(_savedWaypoint.x) + ', ' + Math.round(_savedWaypoint.y) + ', ' + Math.round(_savedWaypoint.z);
  document.getElementById('returnWaypoint').disabled = false;
  appendLog({ at: new Date().toISOString(), message: 'Waypoint saved: ' + readout.textContent });
});

document.getElementById('returnWaypoint').addEventListener('click', () => {
  if (!_savedWaypoint) return;
  socket.emit('command', {
    command: 'go',
    args: { x: _savedWaypoint.x, y: _savedWaypoint.y, z: _savedWaypoint.z }
  });
  appendLog({ at: new Date().toISOString(), message: 'Returning to waypoint: ' + Math.round(_savedWaypoint.x) + ', ' + Math.round(_savedWaypoint.y) + ', ' + Math.round(_savedWaypoint.z) });
});

const proxyTestUrlInput = document.getElementById('proxyTestUrl');
const proxyTestDestInput = document.getElementById('proxyTestDest');
const proxyTestPortInput = document.getElementById('proxyTestPort');
const testProxyBtn = document.getElementById('testProxy');
const proxyLog = document.getElementById('proxyLog');

testProxyBtn.addEventListener('click', async () => {
  const proxyUrl = proxyTestUrlInput.value.trim();
  const destHost = proxyTestDestInput.value.trim() || 'google.com';
  const destPort = proxyTestPortInput.value ? Number(proxyTestPortInput.value) : 80;

  if (!proxyUrl) {
    proxyLog.innerHTML = '<div class="diag-entry diag-fail"><span class="diag-label">ERROR</span><span class="diag-detail">Please enter a proxy URL (e.g. socks5://host:1080).</span></div>';
    return;
  }

  testProxyBtn.disabled = true;
  testProxyBtn.textContent = 'Testing…';
  proxyLog.innerHTML = '<div class="diag-idle">Testing proxy: ' + escapeHtml(proxyUrl.replace(/:([^@/]+)@/, ':****@')) + '…</div>';

  try {
    const resp = await fetch('/bot-api/test-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxy: proxyUrl, host: destHost, port: destPort })
    });
    const data = await resp.json();

    if (!resp.ok && !data.steps) {
      proxyLog.innerHTML = '<div class="diag-entry diag-fail"><span class="diag-label">ERROR</span><span class="diag-detail">' + escapeHtml(data.error || 'Unknown error') + '</span></div>';
      return;
    }

    let html = '';
    (data.steps || []).forEach((step) => {
      const cls = step.ok ? 'diag-ok' : 'diag-fail';
      const badge = step.ok ? 'OK' : 'FAIL';
      const ms = step.ms !== null && step.ms !== undefined ? ' <span class="diag-ms">' + step.ms + 'ms</span>' : '';
      html += '<div class="diag-entry ' + cls + '"><span class="diag-badge">' + badge + '</span><span class="diag-label">' + escapeHtml(step.label) + '</span><span class="diag-detail">' + escapeHtml(step.detail || '') + '</span>' + ms + '</div>';
    });
    if (!html) html = '<div class="diag-idle">No results returned.</div>';
    proxyLog.innerHTML = html;
  } catch (err) {
    proxyLog.innerHTML = '<div class="diag-entry diag-fail"><span class="diag-label">ERROR</span><span class="diag-detail">Request failed: ' + escapeHtml(err.message) + '</span></div>';
  } finally {
    testProxyBtn.disabled = false;
    testProxyBtn.textContent = 'Test Proxy';
  }
});

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const diagHostInput = document.getElementById('diagHost');
const diagPortInput = document.getElementById('diagPort');
const runDiagBtn = document.getElementById('runDiagnostics');
const diagLog = document.getElementById('diagLog');

runDiagBtn.addEventListener('click', async () => {
  const host = diagHostInput.value.trim();
  const port = diagPortInput.value ? Number(diagPortInput.value) : 25565;
  if (!host) {
    diagLog.innerHTML = '<div class="diag-entry diag-fail"><span class="diag-label">ERROR</span><span class="diag-detail">Please enter a host or IP address.</span></div>';
    return;
  }

  runDiagBtn.disabled = true;
  runDiagBtn.textContent = 'Running…';
  diagLog.innerHTML = '<div class="diag-idle">Running diagnostics on ' + host + ':' + port + '…</div>';

  try {
    const res = await fetch('/bot-api/diagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port })
    });
    const data = await res.json();
    renderDiagResults(host, port, data);
  } catch (err) {
    diagLog.innerHTML = '<div class="diag-entry diag-fail"><span class="diag-label">ERROR</span><span class="diag-detail">Request failed: ' + err.message + '</span></div>';
  } finally {
    runDiagBtn.disabled = false;
    runDiagBtn.textContent = 'Run Diagnostics';
  }
});

function renderDiagResults(host, port, data) {
  const ts = new Date().toLocaleTimeString();
  let html = '<div class="diag-header">> Diagnostics for <strong>' + host + ':' + port + '</strong> &nbsp;<span class="diag-ts">' + ts + '</span></div>';
  const steps = (data.results && data.results.steps) || [];
  if (steps.length === 0) {
    html += '<div class="diag-entry diag-fail"><span class="diag-label">FAIL</span><span class="diag-detail">' + (data.error || 'Unknown error') + '</span></div>';
  } else {
    steps.forEach((step) => {
      const cls = step.ok ? 'diag-ok' : 'diag-fail';
      const badge = step.ok ? 'OK' : 'FAIL';
      const ms = step.ms != null ? ' <span class="diag-ms">' + step.ms + 'ms</span>' : '';
      html += '<div class="diag-entry ' + cls + '"><span class="diag-label">' + step.label + '</span><span class="diag-badge">' + badge + '</span><span class="diag-detail">' + step.detail + '</span>' + ms + '</div>';
    });
  }
  diagLog.innerHTML = html;
}

// ── Role Management ───────────────────────────────────────────────────────────

async function fetchRoles() {
  try {
    const res = await fetch('/bot-api/roles', { cache: 'no-store' });
    if (!res.ok) throw new Error('roles fetch failed');
    renderRoles(await res.json());
  } catch (err) {
    appendLog({ at: new Date().toISOString(), message: 'Role fetch error: ' + err.message });
  }
}

function renderRoles(data) {
  const ownerList  = document.getElementById('roleOwnerList');
  const adminList  = document.getElementById('roleAdminList');
  const managerList = document.getElementById('roleManagerList');
  if (!ownerList) return;

  ownerList.innerHTML = '';
  adminList.innerHTML = '';
  managerList.innerHTML = '';

  if (data.ownerMcName) ownerList.appendChild(makeRoleEntry(data.ownerMcName, 'MC', null, null));
  if (data.ownerDiscordId && data.ownerDiscordId !== '') {
    ownerList.appendChild(makeRoleEntry('Discord owner (set)', 'Discord', null, null));
  }
  if (ownerList.children.length === 0) {
    ownerList.innerHTML = '<span class="role-empty">No owner configured in env</span>';
  }

  (data.adminMcNames || []).forEach(name => {
    if (_userTier >= TIER_OWNER) {
      adminList.appendChild(makeRoleEntry(name, 'MC', 'adminMcNames', name));
    } else {
      adminList.appendChild(makeRoleEntry(name, 'MC', null, null));
    }
  });
  (data.adminDiscordIds || []).forEach(id => {
    if (_userTier >= TIER_OWNER) {
      adminList.appendChild(makeRoleEntry(id, 'Discord', 'adminDiscordIds', id));
    } else {
      adminList.appendChild(makeRoleEntry(id, 'Discord', null, null));
    }
  });
  if (adminList.children.length === 0) adminList.innerHTML = '<span class="role-empty">No admins configured</span>';

  (data.managerMcNames || []).forEach(name => {
    managerList.appendChild(makeRoleEntry(name, 'MC', 'managerMcNames', name));
  });
  (data.managerDiscordIds || []).forEach(id => {
    managerList.appendChild(makeRoleEntry(id, 'Discord', 'managerDiscordIds', id));
  });
  if (managerList.children.length === 0) managerList.innerHTML = '<span class="role-empty">No managers configured</span>';

  const addRoleSelect = document.getElementById('roleAddRole');
  if (addRoleSelect) {
    const adminOpt = addRoleSelect.querySelector('option[value="admin"]');
    if (adminOpt) adminOpt.disabled = (_userTier < TIER_OWNER);
  }
}

function makeRoleEntry(label, type, field, value) {
  const row = document.createElement('div');
  row.className = 'role-entry';
  const info = document.createElement('span');
  info.className = 'role-entry-name';
  info.textContent = label;
  const badge = document.createElement('span');
  badge.className = 'role-type-badge ' + (type === 'Discord' ? 'badge-discord' : 'badge-mc');
  badge.textContent = type;
  row.appendChild(info);
  row.appendChild(badge);
  if (field && value) {
    const btn = document.createElement('button');
    btn.className = 'role-remove-btn danger';
    btn.textContent = 'Remove';
    btn.addEventListener('click', () => {
      showConfirm('Remove "' + label + '" from this role?', () => removeRoleUser(field, value));
    });
    row.appendChild(btn);
  }
  return row;
}

async function removeRoleUser(field, value) {
  try {
    const res = await fetch('/bot-api/roles/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field, value, actorId: _userIdentity })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Remove failed');
    appendLog({ at: new Date().toISOString(), message: 'Removed ' + value + ' from ' + field });
    fetchRoles();
  } catch (err) {
    appendLog({ at: new Date().toISOString(), message: 'Role remove error: ' + err.message });
  }
}

document.getElementById('refreshRoles').addEventListener('click', () => {
  if (panelUnlocked && _userTier >= TIER_ADMIN) fetchRoles();
});

document.getElementById('roleAddBtn').addEventListener('click', async () => {
  const identifier = document.getElementById('roleAddIdentifier').value.trim();
  const type = document.getElementById('roleAddType').value;
  const role = document.getElementById('roleAddRole').value;
  const msg = document.getElementById('roleAddMsg');

  if (!identifier) { msg.textContent = 'Enter an MC username or Discord ID.'; msg.className = 'role-add-msg error'; return; }

  let field;
  if (role === 'admin' && type === 'mc')      field = 'adminMcNames';
  if (role === 'admin' && type === 'discord') field = 'adminDiscordIds';
  if (role === 'manager' && type === 'mc')    field = 'managerMcNames';
  if (role === 'manager' && type === 'discord') field = 'managerDiscordIds';

  try {
    const res = await fetch('/bot-api/roles/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field, value: identifier, actorId: _userIdentity })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Add failed');
    msg.textContent = data.added ? 'Added ' + identifier + ' as ' + role + '.' : identifier + ' already in that role.';
    msg.className = 'role-add-msg success';
    document.getElementById('roleAddIdentifier').value = '';
    fetchRoles();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'role-add-msg error';
  }
  setTimeout(() => { msg.textContent = ''; msg.className = 'role-add-msg'; }, 4000);
});

// ── Confirmation Modal ────────────────────────────────────────────────────────

let _confirmCallback = null;

function showConfirm(text, onConfirm) {
  document.getElementById('confirmModalText').textContent = text;
  document.getElementById('confirmModal').style.display = '';
  _confirmCallback = onConfirm;
}

document.getElementById('confirmModalYes').addEventListener('click', () => {
  document.getElementById('confirmModal').style.display = 'none';
  if (typeof _confirmCallback === 'function') _confirmCallback();
  _confirmCallback = null;
});

document.getElementById('confirmModalNo').addEventListener('click', () => {
  document.getElementById('confirmModal').style.display = 'none';
  _confirmCallback = null;
});

document.getElementById('confirmModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('confirmModal')) {
    document.getElementById('confirmModal').style.display = 'none';
    _confirmCallback = null;
  }
});

// ── AI Brain Panel ───────────────────────────────────────────────────────────
(function () {
  const goalInput     = document.getElementById('aiGoalInput');
  const goalRunBtn    = document.getElementById('aiGoalRun');
  const goalStopBtn   = document.getElementById('aiGoalStop');
  const chatToggleBtn = document.getElementById('aiChatToggle');
  const providerBadge = document.getElementById('aiProviderBadge');
  const providerDot   = document.getElementById('aiProviderDot');
  const providerLabel = document.getElementById('aiProviderLabel');
  const goalStatus    = document.getElementById('aiGoalStatus');
  const goalLabel     = document.getElementById('aiGoalLabel');
  const goalStepCount = document.getElementById('aiGoalStepCount');
  const goalStepsList = document.getElementById('aiGoalSteps');
  const chatFeed      = document.getElementById('aiChatFeed');

  let _aiChatEnabled = false;
  const MAX_FEED_LINES = 40;

  // ── Provider badge ────────────────────────────────────────────────────────
  function renderProvider(info) {
    if (!info) { providerBadge.dataset.state = 'unknown'; providerLabel.textContent = 'Checking…'; return; }
    if (!info.available) {
      providerBadge.dataset.state = 'none';
      providerLabel.textContent   = 'No API Key';
      return;
    }
    providerBadge.dataset.state = info.provider;
    providerLabel.textContent   = info.provider.toUpperCase() + ' · ' + (info.model || '');
  }

  // ── AI Chat toggle display ────────────────────────────────────────────────
  function setAiChatDisplay(enabled) {
    _aiChatEnabled = enabled;
    chatToggleBtn.textContent = 'AI Chat: ' + (enabled ? 'ON' : 'OFF');
    chatToggleBtn.className   = enabled ? 'ai-chat-on' : 'ai-chat-off';
  }

  chatToggleBtn.addEventListener('click', () => {
    const next = !_aiChatEnabled;
    socket.emit('set_ai_chat', { enabled: next });
    setAiChatDisplay(next);
  });

  // ── Run Goal ──────────────────────────────────────────────────────────────
  function submitGoal() {
    const txt = (goalInput.value || '').trim();
    if (!txt) return;
    socket.emit('set_ai_goal', { goal: txt });
    goalInput.value = '';
  }

  goalRunBtn.addEventListener('click', submitGoal);
  goalInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGoal(); });
  goalStopBtn.addEventListener('click', () => {
    socket.emit('set_ai_goal', { stop: true });
    goalStatus.style.display = 'none';
  });

  // ── Render goal progress ──────────────────────────────────────────────────
  const STEP_ICONS = { done: '✓', running: '↻', pending: '○' };

  function renderGoalUpdate(data) {
    if (!data) return;

    // Planning state (LLM is generating the plan)
    if (data.planning) {
      goalStatus.style.display = '';
      goalLabel.textContent    = '"' + (data.goalText || '') + '"';
      goalStepCount.textContent = 'Planning…';
      goalStepsList.innerHTML  = '<div class="ai-step-planning">Contacting LLM — generating step plan…</div>';
      return;
    }

    if (!data.goal) {
      // Goal cleared / completed
      if (data.completed) {
        goalStepCount.textContent = 'Completed!';
        // Leave the steps visible for a moment then hide
        setTimeout(() => {
          if (goalStepCount.textContent === 'Completed!') goalStatus.style.display = 'none';
        }, 6000);
      } else {
        goalStatus.style.display = 'none';
      }
      return;
    }

    const g = data.goal;
    goalStatus.style.display  = '';
    goalLabel.textContent     = '"' + g.text + '"';
    goalStepCount.textContent = (g.stepIndex + (data.running ? 0 : 0)) + ' / ' + g.totalSteps + ' steps';

    goalStepsList.innerHTML = (g.steps || []).map((step, i) => {
      const st = step.status || 'pending';
      return '<div class="ai-step-item ai-step-' + st + '">' +
               '<span class="ai-step-icon">' + (STEP_ICONS[st] || '○') + '</span>' +
               '<span class="ai-step-desc">' + escapeHtml(step.description || step.action) + '</span>' +
               '<span class="ai-step-badge ai-step-badge-' + st + '">' + st + '</span>' +
             '</div>';
    }).join('');
  }

  // ── AI Conversation feed ──────────────────────────────────────────────────
  function appendAiMessage(data) {
    // Remove empty placeholder
    const empty = chatFeed.querySelector('.ai-feed-empty');
    if (empty) empty.remove();

    const line = document.createElement('div');
    line.className = 'ai-feed-line';

    const ts = document.createElement('span');
    ts.className   = 'ai-feed-ts';
    ts.textContent = new Date(data.at || Date.now()).toLocaleTimeString();

    const user = document.createElement('span');
    user.className   = 'ai-feed-user';
    user.textContent = data.username + ':';

    const msg = document.createElement('span');
    msg.className   = 'ai-feed-msg ai-feed-player';
    msg.textContent = ' ' + data.message;

    const sep = document.createElement('span');
    sep.className   = 'ai-feed-sep';
    sep.textContent = ' → ';

    const reply = document.createElement('span');
    reply.className   = 'ai-feed-msg ai-feed-bot';
    reply.textContent = data.reply;

    line.append(ts, user, msg, sep, reply);
    chatFeed.appendChild(line);
    chatFeed.scrollTop = chatFeed.scrollHeight;

    while (chatFeed.children.length > MAX_FEED_LINES) {
      chatFeed.removeChild(chatFeed.firstChild);
    }
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Socket events ─────────────────────────────────────────────────────────
  socket.on('ai_goal_update',  renderGoalUpdate);
  socket.on('ai_chat_reply',   appendAiMessage);
  socket.on('ai_chat_state',   (d) => { if (d && typeof d.llmChatEnabled === 'boolean') setAiChatDisplay(d.llmChatEnabled); });

  // ── Fetch initial AI status on load ───────────────────────────────────────
  async function fetchAiStatus() {
    try {
      const r = await fetch('/bot-api/ai/status', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      if (d.provider)       renderProvider(d.provider);
      if (typeof d.llmChatEnabled === 'boolean') setAiChatDisplay(d.llmChatEnabled);
      if (d.goal)           renderGoalUpdate(d.goal);
    } catch (_) {}
  }

  fetchAiStatus();
  setInterval(fetchAiStatus, 20000);
})();

// ─── Connection Health (KeepAlive) widget ────────────────────────────────
(function () {
  const widget   = document.getElementById('keepaliveWidget');
  if (!widget) return;
  const elStatus = document.getElementById('keepaliveStatus');
  const elRate   = document.getElementById('kaPacketRate');
  const elLast   = document.getElementById('kaLastPacket');
  const elLag    = document.getElementById('kaLagWarns');
  const elSil    = document.getElementById('kaSilenceWarns');

  function formatMs(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return ms + ' ms';
    return (ms / 1000).toFixed(1) + ' s';
  }

  function classify(stats) {
    if (!stats || !stats.attached) return { state: 'idle', label: 'Idle' };
    if (stats.msSinceLastPacket > 22000) return { state: 'bad',  label: 'Lagging' };
    if (stats.msSinceLastPacket > 8000)  return { state: 'warn', label: 'Slow' };
    if (stats.lagWarnings > 0 && Date.now() - (window._lastLagWarnAt || 0) < 30000) {
      return { state: 'warn', label: 'Loop lag' };
    }
    return { state: 'healthy', label: 'Online' };
  }

  let lastSeen = { lagWarnings: 0 };
  socket.on('keepalive', (stats) => {
    if (!stats) return;
    if (stats.lagWarnings > (lastSeen.lagWarnings || 0)) {
      window._lastLagWarnAt = Date.now();
    }
    lastSeen = stats;
    const verdict = classify(stats);
    widget.dataset.state = verdict.state;
    elStatus.textContent = verdict.label;
    elRate.textContent = stats.attached ? (stats.packetsPerSec + ' pkt/s') : '—';
    elLast.textContent = stats.attached ? formatMs(stats.msSinceLastPacket) : '—';
    elLag.textContent  = stats.lagWarnings || 0;
    elSil.textContent  = stats.warnings || 0;
  });
})();

// ── Fleet Manager Panel ───────────────────────────────────────────────────────
(function () {
  const fleetUsernameInput = document.getElementById('fleetUsername');
  const fleetSpawnBtn      = document.getElementById('fleetSpawnBtn');
  const fleetDismissAllBtn = document.getElementById('fleetDismissAllBtn');
  const fleetAttackInput   = document.getElementById('fleetAttackInput');
  const fleetAttackBtn     = document.getElementById('fleetAttackBtn');
  const fleetBuildSelect   = document.getElementById('fleetBuildSelect');
  const fleetBuildBtn      = document.getElementById('fleetBuildBtn');
  const fleetBotList       = document.getElementById('fleetBotList');
  const fleetCount         = document.getElementById('fleetCount');

  if (!fleetBotList) return;

  // ── Spawn ──────────────────────────────────────────────────────────────────
  fleetSpawnBtn.addEventListener('click', () => {
    const username = (fleetUsernameInput.value || '').trim();
    if (!username) {
      appendLog({ at: new Date().toISOString(), message: '[fleet] Enter a username to spawn a bot' });
      return;
    }
    socket.emit('fleet:spawn', { username });
    fleetUsernameInput.value = '';
    fleetSpawnBtn.textContent = 'Spawning…';
    setTimeout(() => { fleetSpawnBtn.textContent = 'Spawn Bot'; }, 2000);
  });

  fleetUsernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fleetSpawnBtn.click();
  });

  // ── Dismiss All ────────────────────────────────────────────────────────────
  fleetDismissAllBtn.addEventListener('click', () => {
    showConfirm('Dismiss all fleet minions?', () => {
      fetch('/bot-api/fleet/dismiss-all', { method: 'POST' })
        .then(() => loadFleetStatus())
        .catch(() => {});
    });
  });

  // ── Group command buttons ─────────────────────────────────────────────────
  document.querySelectorAll('[data-fleet-cmd]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.fleetCmd;
      socket.emit('fleet:command', { cmd });
      appendLog({ at: new Date().toISOString(), message: '[fleet] Group command: ' + cmd });
    });
  });

  // ── Attack All ─────────────────────────────────────────────────────────────
  fleetAttackBtn.addEventListener('click', () => {
    const target = (fleetAttackInput.value || '').trim();
    if (!target) {
      appendLog({ at: new Date().toISOString(), message: '[fleet] Enter a target name first' });
      return;
    }
    socket.emit('fleet:command', { cmd: 'attack', target });
    appendLog({ at: new Date().toISOString(), message: '[fleet] Attack command sent: ' + target });
  });

  fleetAttackInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fleetAttackBtn.click();
  });

  // ── Distribute Build ───────────────────────────────────────────────────────
  fleetBuildBtn.addEventListener('click', async () => {
    const schematic = fleetBuildSelect.value;
    if (!schematic) {
      appendLog({ at: new Date().toISOString(), message: '[fleet] Select a schematic first' });
      return;
    }
    fleetBuildBtn.disabled = true;
    fleetBuildBtn.textContent = 'Building…';
    try {
      const res = await fetch('/bot-api/fleet/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: schematic })
      });
      const data = await res.json();
      appendLog({ at: new Date().toISOString(), message: '[fleet] ' + (data.message || (data.ok ? 'Build started' : (data.error || 'Error'))) });
    } catch (err) {
      appendLog({ at: new Date().toISOString(), message: '[fleet] Build request error: ' + err.message });
    } finally {
      fleetBuildBtn.disabled = false;
      fleetBuildBtn.textContent = 'Distribute Build';
    }
  });

  // ── Render fleet status ────────────────────────────────────────────────────
  function renderFleet(data) {
    if (!data) return;
    const minions = Array.isArray(data.minions) ? data.minions : [];
    if (fleetCount) {
      fleetCount.textContent = minions.length + ' minion' + (minions.length === 1 ? '' : 's');
    }

    if (!minions.length) {
      fleetBotList.innerHTML = '<div class="fleet-empty">No minion bots spawned yet. Enter a username above to add one to the fleet.</div>';
      return;
    }

    fleetBotList.innerHTML = minions.map((m) => {
      const stateClass = {
        online:     'fleet-state-online',
        following:  'fleet-state-following',
        connecting: 'fleet-state-connecting',
        offline:    'fleet-state-offline',
        error:      'fleet-state-error',
        busy:       'fleet-state-busy'
      }[m.state] || 'fleet-state-offline';

      const hp    = m.health != null ? Math.round(m.health) : null;
      const hpPct = hp != null ? Math.min(100, (hp / 20) * 100) : 0;
      const hpBar = hp != null
        ? '<div class="fleet-hp-bar"><div class="fleet-hp-fill" style="width:' + hpPct + '%;background:' +
          (hp > 10 ? '#39FF14' : hp > 5 ? '#ffaa00' : '#ff315f') + '"></div></div>'
        : '';

      const pos = m.position
        ? 'X' + m.position.x + ' Y' + m.position.y + ' Z' + m.position.z
        : '—';

      const followBadge = m.following
        ? '<span class="fleet-following-badge">FOLLOWING</span>'
        : '';

      return '<div class="fleet-bot-row">' +
        '<div class="fleet-bot-info">' +
          '<span class="fleet-bot-name">' + escapeHtml(m.username) + '</span>' +
          '<span class="fleet-state-badge ' + stateClass + '">' + m.state + '</span>' +
          followBadge +
          '<span class="fleet-bot-pos">' + pos + '</span>' +
        '</div>' +
        hpBar +
        '<div class="fleet-bot-meta">' +
          (hp != null ? '<span>' + hp + ' HP</span>' : '') +
          '<span>' + (m.invCount || 0) + ' items</span>' +
        '</div>' +
        '<button class="fleet-dismiss-single danger" data-fleet-id="' + escapeHtml(m.id) + '">Dismiss</button>' +
      '</div>';
    }).join('');

    fleetBotList.querySelectorAll('.fleet-dismiss-single').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.fleetId;
        showConfirm('Dismiss fleet bot "' + id + '"?', () => {
          fetch('/bot-api/fleet/dismiss/' + encodeURIComponent(id), { method: 'POST' })
            .then(() => loadFleetStatus())
            .catch(() => {});
        });
      });
    });
  }

  // ── Socket listener ────────────────────────────────────────────────────────
  socket.on('fleet:update', (data) => {
    if (data) renderFleet(data);
  });

  // ── Initial load + polling fallback ───────────────────────────────────────
  async function loadFleetStatus() {
    try {
      const r = await fetch('/bot-api/fleet/status', { cache: 'no-store' });
      if (r.ok) {
        const body = await r.json();
        if (body && body.fleet) renderFleet(body.fleet);
      }
    } catch (_) {}
  }

  loadFleetStatus();
  setInterval(() => { if (!document.hidden) loadFleetStatus(); }, 8000);
})();

// ── Hive Mind Dashboard ───────────────────────────────────────────────────────
(function () {
  'use strict';

  var rosterEl   = document.getElementById('hiveRoster');
  var poolEl     = document.getElementById('hivePool');
  var enemiesEl  = document.getElementById('hiveEnemies');
  var intelEl    = document.getElementById('hiveIntelFeed');
  var onlineEl   = document.getElementById('hiveOnlineBots');
  var totalEl    = document.getElementById('hiveTotalBots');
  var dangerCEl  = document.getElementById('hiveDangerCount');
  var enemyCEl   = document.getElementById('hiveEnemyCount');

  if (!rosterEl) return;

  var MAX_INTEL = 60;

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function timeAgo(isoStr) {
    var secs = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
    if (secs < 60)  return secs + 's ago';
    if (secs < 3600) return Math.floor(secs/60) + 'm ago';
    return Math.floor(secs/3600) + 'h ago';
  }

  function fmtTime(isoStr) {
    var d = new Date(isoStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  // ── Render roster ───────────────────────────────────────────────────────────
  var SV_COLORS = {
    idle:       { bg: 'rgba(117,168,168,0.12)', fg: 'var(--muted)',  label: 'IDLE' },
    eating:     { bg: 'rgba(255,200,50,0.18)',  fg: '#ffc832',       label: 'EATING' },
    hunting:    { bg: 'rgba(255,200,50,0.18)',  fg: '#ffc832',       label: 'HUNTING' },
    healing:    { bg: 'rgba(57,255,20,0.15)',   fg: 'var(--green)',  label: 'HEALING' },
    fleeing:    { bg: 'rgba(255,49,95,0.18)',   fg: 'var(--red)',    label: 'FLEEING' },
    critical:   { bg: 'rgba(255,49,95,0.30)',   fg: '#ff315f',       label: '⚠ CRIT' },
    sheltering: { bg: 'rgba(0,200,255,0.18)',   fg: 'var(--cyan)',   label: 'SHELTER' },
    armoring:   { bg: 'rgba(0,255,255,0.15)',   fg: 'var(--cyan)',   label: 'ARMOR' },
    toolcraft:  { bg: 'rgba(0,255,255,0.15)',   fg: 'var(--cyan)',   label: 'CRAFTING' },
    'craft_tool': { bg: 'rgba(0,255,255,0.15)', fg: 'var(--cyan)',   label: 'CRAFTING' }
  };

  function renderRoster(bots) {
    if (!bots || !bots.length) {
      rosterEl.innerHTML = '<div class="hive-empty">No bots linked to Hive yet.</div>';
      return;
    }
    rosterEl.innerHTML = bots.map(function (b) {
      var hp    = b.health != null ? Math.round(b.health) : null;
      var pos   = b.position ? 'X' + b.position.x + ' Y' + b.position.y + ' Z' + b.position.z : '—';
      var task  = b.currentTask && !String(b.currentTask).startsWith('survival:')
        ? '<span class="hive-bot-task">' + esc(b.currentTask) + '</span>'
        : '';
      var hpStr = hp != null ? '<span class="hive-bot-hp">♥ ' + hp + '</span>' : '';
      var hunger = b.hunger != null ? '<span class="hive-bot-hunger" title="hunger">🍖 ' + b.hunger + '</span>' : '';

      var sv = b.survivalState && SV_COLORS[b.survivalState]
        ? SV_COLORS[b.survivalState]
        : (b.survivalState ? { bg:'rgba(117,168,168,0.12)', fg:'var(--muted)', label: b.survivalState.toUpperCase() } : null);
      var svBadge = (sv && b.survivalState !== 'idle')
        ? '<span class="hive-sv-badge" style="background:' + sv.bg + ';color:' + sv.fg + ';border-color:' + sv.fg + '">' + esc(sv.label) + '</span>'
        : '';

      return '<div class="hive-bot-row' + (b.online ? '' : ' hive-bot-offline') + '">' +
        '<span class="hive-bot-role ' + esc(b.role) + '">' + esc(b.role.toUpperCase()) + '</span>' +
        '<span class="hive-bot-name">' + esc(b.username) + '</span>' +
        hpStr + hunger +
        '<span style="font-size:0.68rem;color:var(--muted);">' + esc(pos) + '</span>' +
        svBadge + task +
        '<span style="font-size:0.65rem;color:' + (b.online ? '#39FF14' : '#ff315f') + ';margin-left:auto">' +
          (b.online ? '● ONLINE' : '○ OFFLINE') + '</span>' +
      '</div>';
    }).join('');
  }

  // ── Render resource pool ────────────────────────────────────────────────────
  function renderPool(pool) {
    if (!pool || !Object.keys(pool).length) {
      poolEl.innerHTML = '<div class="hive-empty">No inventory data yet.</div>';
      return;
    }
    poolEl.innerHTML = Object.entries(pool).map(function (kv) {
      return '<span class="hive-pool-item">' +
        esc(kv[0].replace(/_/g, ' ')) +
        ' <span class="hive-pool-count">×' + kv[1] + '</span>' +
      '</span>';
    }).join('');
  }

  // ── Render known enemies ────────────────────────────────────────────────────
  function renderEnemies(enemies) {
    if (!enemies || !enemies.length) {
      enemiesEl.innerHTML = '<div class="hive-empty">No threats tracked.</div>';
      return;
    }
    enemiesEl.innerHTML = enemies.map(function (e) {
      return '<div class="hive-enemy-row">' +
        '<span class="hive-enemy-name">' + esc(e.name) + '</span>' +
        '<span class="hive-enemy-pos">X' + e.x + ' Y' + e.y + ' Z' + e.z + '</span>' +
        '<span class="hive-enemy-age">' + timeAgo(new Date(e.lastSeen).toISOString()) + '</span>' +
      '</div>';
    }).join('');
  }

  // ── Render intel feed (prepend new entries at top) ──────────────────────────
  function renderIntel(entries, prepend) {
    if (!entries || !entries.length) return;
    if (!prepend) {
      intelEl.innerHTML = entries.slice().reverse().map(buildIntelRow).join('');
      return;
    }
    var frag = document.createDocumentFragment();
    entries.slice().reverse().forEach(function (entry) {
      var div = document.createElement('div');
      div.innerHTML = buildIntelRow(entry);
      var row = div.firstChild;
      if (row) {
        row.classList.add('hive-intel-new');
        frag.insertBefore(row, frag.firstChild);
      }
    });
    intelEl.insertBefore(frag, intelEl.firstChild);
    // Trim overflow
    while (intelEl.children.length > MAX_INTEL) {
      intelEl.removeChild(intelEl.lastChild);
    }
  }

  function buildIntelRow(entry) {
    return '<div class="hive-intel-row">' +
      '<span class="hive-intel-time">' + fmtTime(entry.at) + '</span>' +
      '<span class="hive-intel-type ' + esc(entry.type || 'system') + '">' + esc(entry.type || 'sys') + '</span>' +
      '<span class="hive-intel-msg">' + esc(entry.message) + '</span>' +
    '</div>';
  }

  // ── Render survival overview grid ───────────────────────────────────────────
  var survivalGridEl = document.getElementById('hiveSurvivalGrid');

  function renderSurvivalGrid(bots) {
    if (!survivalGridEl) return;
    if (!bots || !bots.length) {
      survivalGridEl.innerHTML = '<div class="hive-empty">No bots active.</div>';
      return;
    }
    survivalGridEl.innerHTML = bots.map(function (b) {
      var sv  = b.survivalState || 'idle';
      var cfg = SV_COLORS[sv] || { bg: 'rgba(117,168,168,0.12)', fg: 'var(--muted)', label: sv.toUpperCase() };
      var hp  = b.health != null ? Math.round(b.health) : '?';
      var hun = b.hunger != null ? b.hunger : '?';
      return '<div class="sv-overview-chip" style="border-color:' + cfg.fg + '40;">' +
        '<span class="sv-name">' + esc(b.username) + '</span>' +
        '<span class="sv-state" style="color:' + cfg.fg + ';">' + cfg.label + '</span>' +
        '<span style="font-size:0.62rem;color:#ff6b8a;">♥' + hp + '</span>' +
        '<span style="font-size:0.62rem;color:#ffc832;">🍖' + hun + '</span>' +
      '</div>';
    }).join('');
  }

  // ── Full render from status snapshot ────────────────────────────────────────
  function applyStatus(hive) {
    if (!hive) return;
    if (onlineEl) onlineEl.textContent = hive.onlineBots || 0;
    if (totalEl)  totalEl.textContent  = hive.totalBots  || 0;
    if (dangerCEl) dangerCEl.textContent = hive.dangerZoneCount || 0;
    if (enemyCEl)  enemyCEl.textContent  = (hive.knownEnemies || []).length;
    renderRoster(hive.bots || []);
    renderPool(hive.pool || {});
    renderEnemies(hive.knownEnemies || []);
    renderSurvivalGrid(hive.bots || []);
    if (hive.intelFeed && hive.intelFeed.length) {
      renderIntel(hive.intelFeed, false);
    }
  }

  // ── Socket listeners ─────────────────────────────────────────────────────────
  socket.on('hive:update', function (hive) {
    applyStatus(hive);
  });

  socket.on('hive:intel', function (entry) {
    renderIntel([entry], true);
  });

  socket.on('hive:pool', function (pool) {
    renderPool(pool);
  });

  socket.on('hive:enemySpotted', function (data) {
    if (enemyCEl) enemyCEl.textContent = String(Number(enemyCEl.textContent || 0) + 1);
  });

  socket.on('hive:dangerZone', function (data) {
    if (dangerCEl) dangerCEl.textContent = String(Number(dangerCEl.textContent || 0) + 1);
  });

  // ── Broadcast alert button ───────────────────────────────────────────────────
  var broadcastBtn   = document.getElementById('hiveBroadcastBtn');
  var broadcastInput = document.getElementById('hiveBroadcastInput');
  if (broadcastBtn && broadcastInput) {
    broadcastBtn.addEventListener('click', async function () {
      var msg = (broadcastInput.value || '').trim();
      if (!msg) return;
      broadcastBtn.disabled = true;
      broadcastBtn.textContent = 'Sending…';
      try {
        await fetch('/bot-api/hive/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'alert', payload: { message: msg } })
        });
        broadcastInput.value = '';
      } catch (_) {}
      broadcastBtn.disabled = false;
      broadcastBtn.textContent = 'Broadcast Alert';
    });
    broadcastInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') broadcastBtn.click();
    });
  }

  // ── Flag danger zone button ──────────────────────────────────────────────────
  var flagBtn    = document.getElementById('hiveFlagDangerBtn');
  var dangerXEl  = document.getElementById('hiveDangerX');
  var dangerYEl  = document.getElementById('hiveDangerY');
  var dangerZEl  = document.getElementById('hiveDangerZ');
  var dangerREl  = document.getElementById('hiveDangerReason');
  if (flagBtn) {
    flagBtn.addEventListener('click', async function () {
      var x = parseFloat(dangerXEl.value), y = parseFloat(dangerYEl.value), z = parseFloat(dangerZEl.value);
      if (isNaN(x) || isNaN(y) || isNaN(z)) { alert('Enter valid X, Y, Z coordinates.'); return; }
      flagBtn.disabled = true;
      flagBtn.textContent = 'Flagging…';
      try {
        await fetch('/bot-api/hive/danger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x, y, z, reason: (dangerREl.value || '').trim() || 'manual' })
        });
        dangerXEl.value = ''; dangerYEl.value = ''; dangerZEl.value = ''; dangerREl.value = '';
      } catch (_) {}
      flagBtn.disabled = false;
      flagBtn.textContent = 'Flag Danger Zone';
    });
  }

  // ── Initial load ─────────────────────────────────────────────────────────────
  async function loadHive() {
    try {
      var r = await fetch('/bot-api/hive/status', { cache: 'no-store' });
      if (r.ok) {
        var body = await r.json();
        if (body && body.hive) applyStatus(body.hive);
      }
    } catch (_) {}
  }

  loadHive();
  setInterval(function () { if (!document.hidden) loadHive(); }, 10000);
})();

// ── Social Intel Dashboard ────────────────────────────────────────────────────
(function () {
  'use strict';

  var gridEl         = document.getElementById('socialProfileGrid');
  var feedEl         = document.getElementById('socialFeed');
  var friendlyNumEl  = document.getElementById('socialFriendlyNum');
  var neutralNumEl   = document.getElementById('socialNeutralNum');
  var hostileNumEl   = document.getElementById('socialHostileNum');
  var refreshBtn     = document.getElementById('socialRefreshBtn');

  if (!gridEl) return;

  var MAX_FEED  = 80;
  var _profiles = {};   // Map username → last known profile snapshot
  var _feed     = [];   // [{at, username, type, rapportScore, classification}]

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function fmtTime(isoStr) {
    try {
      var d = new Date(isoStr);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    } catch (_) { return '—'; }
  }

  function timeAgo(isoStr) {
    if (!isoStr) return 'never';
    var secs = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
    if (secs < 60)   return secs + 's ago';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
    return Math.floor(secs / 3600) + 'h ago';
  }

  function cls(classification) {
    return (classification || 'neutral').toLowerCase();
  }

  // Convert rapport score -100…+100 into a bar fill (left%, width%, color)
  function rapportBar(score) {
    var clampedScore = Math.max(-100, Math.min(100, score || 0));
    var pct = (clampedScore + 100) / 2; // 0..100 as percent of track
    var left, width, color;
    if (clampedScore >= 0) {
      left  = 50;
      width = pct - 50;
      color = clampedScore > 20 ? '#39FF14' : 'var(--cyan)';
    } else {
      left  = pct;
      width = 50 - pct;
      color = clampedScore < -20 ? '#ff315f' : 'var(--cyan)';
    }
    return { left: left.toFixed(1) + '%', width: width.toFixed(1) + '%', color: color };
  }

  // ── Render a single profile card ──────────────────────────────────────────────

  function buildCard(p) {
    var c       = cls(p.classification);
    var bar     = rapportBar(p.rapportScore);
    var score   = (p.rapportScore >= 0 ? '+' : '') + (p.rapportScore || 0);
    var seen    = timeAgo(p.lastSeen);
    var count   = p.interactionCount || 0;

    return '<div class="social-card ' + c + '" id="social-card-' + esc(p.username) + '">' +
      '<div class="social-card-top">' +
        '<span class="social-card-name">' + esc(p.username) + '</span>' +
        '<span class="social-class-badge ' + c + '">' + esc(p.classification || 'NEUTRAL') + '</span>' +
      '</div>' +
      '<div class="social-rapport-wrap">' +
        '<span class="social-rapport-label">RAPPORT</span>' +
        '<div class="social-rapport-track">' +
          '<div class="social-rapport-zero"></div>' +
          '<div class="social-rapport-fill" style="left:' + bar.left + ';width:' + bar.width + ';background:' + bar.color + '"></div>' +
        '</div>' +
        '<span class="social-rapport-score ' + c + '">' + score + '</span>' +
      '</div>' +
      '<div class="social-card-meta">' +
        '<span class="social-card-stat">Interactions: <strong>' + count + '</strong></span>' +
        '<span class="social-card-stat">Last seen: <strong>' + seen + '</strong></span>' +
        '<button class="social-card-reset" data-username="' + esc(p.username) + '">Reset</button>' +
      '</div>' +
    '</div>';
  }

  // ── Render all profile cards ──────────────────────────────────────────────────

  function renderProfiles() {
    var keys = Object.keys(_profiles);
    if (!keys.length) {
      gridEl.innerHTML = '<div class="social-empty">No players tracked yet. The bot will start building profiles as players chat or interact in-game.</div>';
      if (friendlyNumEl) friendlyNumEl.textContent = '0';
      if (neutralNumEl)  neutralNumEl.textContent  = '0';
      if (hostileNumEl)  hostileNumEl.textContent  = '0';
      return;
    }

    // Sort: hostile first, then neutral, then friendly
    var order = { HOSTILE: 0, NEUTRAL: 1, FRIENDLY: 2 };
    keys.sort(function (a, b) {
      return (order[_profiles[a].classification] || 1) - (order[_profiles[b].classification] || 1);
    });

    var friendly = 0, neutral = 0, hostile = 0;
    keys.forEach(function (k) {
      var c = _profiles[k].classification;
      if (c === 'FRIENDLY') friendly++;
      else if (c === 'HOSTILE') hostile++;
      else neutral++;
    });

    if (friendlyNumEl) friendlyNumEl.textContent = friendly;
    if (neutralNumEl)  neutralNumEl.textContent  = neutral;
    if (hostileNumEl)  hostileNumEl.textContent  = hostile;

    gridEl.innerHTML = keys.map(function (k) { return buildCard(_profiles[k]); }).join('');

    // Attach reset buttons
    gridEl.querySelectorAll('.social-card-reset').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var username = btn.dataset.username;
        if (!username) return;
        if (!confirm('Reset social profile for "' + username + '"?\nThis wipes rapport score and conversation history.')) return;
        btn.disabled = true;
        btn.textContent = 'Resetting…';
        fetch('/bot-api/social/profile/' + encodeURIComponent(username) + '/reset', {
          method: 'POST'
        }).then(function () {
          delete _profiles[username];
          renderProfiles();
        }).catch(function () {
          btn.disabled = false;
          btn.textContent = 'Reset';
        });
      });
    });
  }

  // ── Update a single card in-place (for live socket updates) ─────────────────

  function patchCard(p) {
    _profiles[p.username] = Object.assign(_profiles[p.username] || {}, p);
    var existing = document.getElementById('social-card-' + p.username);
    if (existing) {
      var tmp = document.createElement('div');
      tmp.innerHTML = buildCard(_profiles[p.username]);
      var newCard = tmp.firstElementChild;
      existing.replaceWith(newCard);
      // Flash animation
      newCard.classList.add('just-updated');
      // Re-attach reset
      var resetBtn = newCard.querySelector('.social-card-reset');
      if (resetBtn) {
        resetBtn.addEventListener('click', function () {
          var username = resetBtn.dataset.username;
          if (!confirm('Reset social profile for "' + username + '"?')) return;
          resetBtn.disabled = true;
          fetch('/bot-api/social/profile/' + encodeURIComponent(username) + '/reset', {
            method: 'POST'
          }).then(function () {
            delete _profiles[username];
            renderProfiles();
          }).catch(function () { resetBtn.disabled = false; });
        });
      }
      // Update header counters
      var friendly = 0, neutral = 0, hostile = 0;
      Object.values(_profiles).forEach(function (pr) {
        if (pr.classification === 'FRIENDLY') friendly++;
        else if (pr.classification === 'HOSTILE') hostile++;
        else neutral++;
      });
      if (friendlyNumEl) friendlyNumEl.textContent = friendly;
      if (neutralNumEl)  neutralNumEl.textContent  = neutral;
      if (hostileNumEl)  hostileNumEl.textContent  = hostile;
    } else {
      // New player — full re-render
      renderProfiles();
    }
  }

  // ── Render interaction feed ───────────────────────────────────────────────────

  function renderFeed() {
    if (!_feed.length) {
      feedEl.innerHTML = '<div class="social-feed-empty">No interactions recorded yet.</div>';
      return;
    }
    feedEl.innerHTML = _feed.slice().reverse().map(function (e) {
      var c = cls(e.classification);
      var delta = '';
      if (e.delta !== undefined) {
        delta = (e.delta >= 0 ? '+' : '') + e.delta;
      }
      var score = (e.rapportScore !== undefined) ? ((e.rapportScore >= 0 ? '+' : '') + e.rapportScore) : '';
      return '<div class="social-feed-row">' +
        '<span class="social-feed-time">' + fmtTime(e.at) + '</span>' +
        '<span class="social-feed-user">' + esc(e.username) + '</span>' +
        '<span class="social-feed-type ' + esc(e.type || 'neutral_chat') + '">' + esc((e.type || 'chat').replace(/_/g,' ')) + '</span>' +
        '<span class="social-feed-score ' + c + '">' + score + '</span>' +
      '</div>';
    }).join('');
  }

  function pushFeedEvent(e) {
    e.at = e.at || new Date().toISOString();
    _feed.push(e);
    if (_feed.length > MAX_FEED) _feed = _feed.slice(-MAX_FEED);

    // Prepend to DOM (newest on top)
    var emptyEl = feedEl.querySelector('.social-feed-empty');
    if (emptyEl) emptyEl.remove();

    var row = document.createElement('div');
    var c   = cls(e.classification);
    var score = (e.rapportScore !== undefined) ? ((e.rapportScore >= 0 ? '+' : '') + e.rapportScore) : '';
    row.className = 'social-feed-row new-event';
    row.innerHTML =
      '<span class="social-feed-time">' + fmtTime(e.at) + '</span>' +
      '<span class="social-feed-user">' + esc(e.username) + '</span>' +
      '<span class="social-feed-type ' + esc(e.type || 'neutral_chat') + '">' + esc((e.type || 'chat').replace(/_/g,' ')) + '</span>' +
      '<span class="social-feed-score ' + c + '">' + score + '</span>';
    feedEl.insertBefore(row, feedEl.firstChild);

    // Trim visible rows
    var rows = feedEl.querySelectorAll('.social-feed-row');
    if (rows.length > MAX_FEED) {
      feedEl.removeChild(feedEl.lastChild);
    }
  }

  // ── Socket.IO live events ─────────────────────────────────────────────────────

  if (typeof socket !== 'undefined') {
    socket.on('social:update', function (data) {
      if (!data || !data.username) return;
      var p = {
        username:         data.username,
        rapportScore:     data.rapportScore    !== undefined ? data.rapportScore    : (_profiles[data.username] ? _profiles[data.username].rapportScore : 0),
        classification:   data.classification  || (_profiles[data.username] ? _profiles[data.username].classification : 'NEUTRAL'),
        interactionCount: data.interactionCount !== undefined ? data.interactionCount : (_profiles[data.username] ? _profiles[data.username].interactionCount : 0),
        lastSeen:         new Date().toISOString()
      };
      patchCard(p);
      pushFeedEvent(Object.assign({ at: new Date().toISOString() }, data, p));
    });
  }

  // ── REST API load ─────────────────────────────────────────────────────────────

  async function loadProfiles() {
    try {
      var r = await fetch('/bot-api/social/profiles', { cache: 'no-store' });
      if (!r.ok) return;
      var body = await r.json();
      if (!body.profiles) return;
      _profiles = {};
      body.profiles.forEach(function (p) { _profiles[p.username] = p; });
      renderProfiles();
    } catch (_) {}
  }

  // ── Refresh button ────────────────────────────────────────────────────────────

  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Loading…';
      loadProfiles().finally(function () {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh';
      });
    });
  }

  // ── Initial load + auto-refresh ───────────────────────────────────────────────

  loadProfiles();
  setInterval(function () { if (!document.hidden) loadProfiles(); }, 15000);

})();

// ── Schematic Lab ─────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const nameInput    = document.getElementById('schematicNameInput');
  const jsonInput    = document.getElementById('schematicJsonInput');
  const previewBtn   = document.getElementById('schematicPreviewBtn');
  const saveBtn      = document.getElementById('schematicSaveBtn');
  const previewPanel = document.getElementById('schematicPreviewPanel');
  const previewInfo  = document.getElementById('schematicPreviewInfo');
  const labList      = document.getElementById('schematicLabList');
  const labCount     = document.getElementById('schematicLabCount');

  if (!labList) return;

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function showPreviewError(msg) {
    previewPanel.style.display = '';
    previewInfo.innerHTML = '<div class="sp-error">' + escHtml(msg) + '</div>';
  }

  function showPreview(data) {
    previewPanel.style.display = '';
    const topBlocks = Object.entries(data.blockCounts)
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 15)
      .map(function (e) {
        return '<tr><td class="sp-type">' + escHtml(e[0]) + '</td><td class="sp-count">' + e[1] + '</td></tr>';
      }).join('');
    var d = data.dimensions;
    previewInfo.innerHTML =
      '<div class="sp-stats">' +
        '<span class="sp-stat"><span class="sp-stat-lbl">Name</span><span class="sp-stat-val">' + escHtml(data.name) + '</span></span>' +
        '<span class="sp-stat"><span class="sp-stat-lbl">Total Blocks</span><span class="sp-stat-val">' + data.totalBlocks + '</span></span>' +
        '<span class="sp-stat"><span class="sp-stat-lbl">Unique Types</span><span class="sp-stat-val">' + data.uniqueTypes + '</span></span>' +
        '<span class="sp-stat"><span class="sp-stat-lbl">Size (X×Y×Z)</span><span class="sp-stat-val">' + d.sizeX + '×' + d.sizeY + '×' + d.sizeZ + '</span></span>' +
      '</div>' +
      '<div class="sp-table-label">Block Requirements</div>' +
      '<table class="sp-table"><thead><tr><th>Block Type</th><th>Count</th></tr></thead><tbody>' + topBlocks + '</tbody></table>';
  }

  previewBtn.addEventListener('click', async function () {
    var raw = (jsonInput.value || '').trim();
    if (!raw) { showPreviewError('Paste a JSON schematic first.'); return; }
    previewBtn.disabled = true;
    previewBtn.textContent = 'Validating…';
    try {
      var res = await fetch('/bot-api/schematics/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: raw, name: (nameInput.value || '').trim() })
      });
      var data = await res.json();
      if (!data.ok) { showPreviewError(data.error || 'Invalid schematic'); return; }
      showPreview(data);
    } catch (err) {
      showPreviewError('Request error: ' + err.message);
    } finally {
      previewBtn.disabled = false;
      previewBtn.textContent = 'Preview';
    }
  });

  saveBtn.addEventListener('click', async function () {
    var raw  = (jsonInput.value || '').trim();
    var name = (nameInput.value || '').trim();
    if (!raw) { showPreviewError('Paste a JSON schematic first.'); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      var res = await fetch('/bot-api/schematics/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: raw, name: name })
      });
      var data = await res.json();
      if (!data.ok) { showPreviewError(data.error || 'Save failed'); return; }
      jsonInput.value = '';
      nameInput.value = '';
      previewPanel.style.display = 'none';
      if (typeof appendLog === 'function') {
        appendLog({ at: new Date().toISOString(), message: '[lab] Saved "' + data.name + '" (' + data.totalBlocks + ' blocks)' });
      }
      loadSchematics();
    } catch (err) {
      showPreviewError('Save error: ' + err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save to Lab';
    }
  });

  async function loadSchematics() {
    try {
      var r = await fetch('/bot-api/schematics', { cache: 'no-store' });
      if (!r.ok) return;
      var data = await r.json();
      renderSchematics(data.schematics || []);
    } catch (_) {}
  }

  function renderSchematics(list) {
    if (labCount) labCount.textContent = list.length + ' saved';
    if (!list.length) {
      labList.innerHTML = '<div class="schematic-lab-empty">No schematics saved yet. Paste JSON above and click Save to Lab.</div>';
      return;
    }
    labList.innerHTML = list.map(function (s) {
      var topTypes = Object.entries(s.blockCounts)
        .sort(function (a, b) { return b[1] - a[1]; })
        .slice(0, 3)
        .map(function (e) { return e[1] + '×' + e[0]; })
        .join(', ');
      return '<div class="schematic-lab-item">' +
        '<div class="sl-info">' +
          '<span class="sl-name">' + escHtml(s.name) + '</span>' +
          '<span class="sl-meta">' + s.totalBlocks + ' blocks  ·  ' + escHtml(topTypes) +
            (s.dimensions ? '  ·  ' + s.dimensions.sizeX + '×' + s.dimensions.sizeY + '×' + s.dimensions.sizeZ : '') +
          '</span>' +
        '</div>' +
        '<div class="sl-actions">' +
          '<button class="sl-deploy-btn" data-sid="' + escHtml(s.id) + '">Deploy to Fleet</button>' +
          '<button class="sl-delete-btn danger" data-sid="' + escHtml(s.id) + '">Delete</button>' +
        '</div>' +
      '</div>';
    }).join('');

    labList.querySelectorAll('.sl-deploy-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { deploySchematic(btn.dataset.sid, btn); });
    });
    labList.querySelectorAll('.sl-delete-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { deleteSchematic(btn.dataset.sid); });
    });
  }

  async function deploySchematic(id, btn) {
    btn.disabled = true;
    btn.textContent = 'Deploying…';
    try {
      var res = await fetch('/bot-api/schematics/' + encodeURIComponent(id) + '/deploy', { method: 'POST' });
      var data = await res.json();
      var msg = data.message || (data.ok ? 'Deploy started' : (data.error || 'Unknown error'));
      if (typeof appendLog === 'function') {
        appendLog({ at: new Date().toISOString(), message: '[lab] ' + msg });
      }
    } catch (err) {
      if (typeof appendLog === 'function') {
        appendLog({ at: new Date().toISOString(), message: '[lab] Deploy error: ' + err.message });
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Deploy to Fleet';
    }
  }

  async function deleteSchematic(id) {
    try {
      await fetch('/bot-api/schematics/' + encodeURIComponent(id), { method: 'DELETE' });
      loadSchematics();
    } catch (_) {}
  }

  loadSchematics();
  setInterval(function () { if (!document.hidden) loadSchematics(); }, 30000);
})();

// ═══════════════════════════════════════════════════════════════════════════
// FAERO UI v2 — Progress Bars · Radar · Formation · Macros · Sidebar Toggle
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ── Vital-sign progress bars ────────────────────────────────────────────
  var healthBar = document.getElementById('healthBar');
  var hungerBar = document.getElementById('hungerBar');

  function updateVitalBar(barEl, value, max) {
    if (!barEl) return;
    var pct = Math.max(0, Math.min(100, (value / max) * 100));
    barEl.style.width = pct.toFixed(1) + '%';
    // Health colour tiers
    if (barEl === healthBar) {
      barEl.classList.toggle('high', pct > 60);
      barEl.classList.toggle('mid',  pct > 25 && pct <= 60);
      barEl.classList.toggle('low',  pct <= 25);
    }
    // Hunger colour tiers
    if (barEl === hungerBar) {
      barEl.classList.toggle('high', pct > 55);
      barEl.classList.toggle('mid',  pct > 25 && pct <= 55);
      barEl.classList.toggle('low',  pct <= 25);
    }
  }

  // Intercept socket status updates to drive bars
  if (typeof socket !== 'undefined') {
    socket.on('status', function (data) {
      if (!data) return;
      // Health: max 20
      if (data.health !== undefined && data.health !== null) {
        var hp = parseFloat(data.health);
        if (!isNaN(hp)) updateVitalBar(healthBar, hp, 20);
      }
      // Hunger/food: max 20
      if (data.food !== undefined && data.food !== null) {
        var food = parseFloat(data.food);
        if (!isNaN(food)) updateVitalBar(hungerBar, food, 20);
      } else if (data.hunger !== undefined && data.hunger !== null) {
        var hunger = parseFloat(data.hunger);
        if (!isNaN(hunger)) updateVitalBar(hungerBar, hunger, 20);
      }
    });
  }

  // Also parse text content that client.js already writes to #health/#hunger
  var healthEl = document.getElementById('health');
  var hungerEl = document.getElementById('hunger');

  function observeTextEl(el, barEl, max) {
    if (!el || !barEl) return;
    var observer = new MutationObserver(function () {
      var txt = (el.textContent || '').replace(/[^0-9.]/g, '').trim();
      var val = parseFloat(txt);
      if (!isNaN(val)) updateVitalBar(barEl, val, max);
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
  }

  observeTextEl(healthEl, healthBar, 20);
  observeTextEl(hungerEl, hungerBar, 20);

  // ── Fleet Radar Canvas ──────────────────────────────────────────────────
  var radarCanvas = document.getElementById('radarCanvas');
  var radarCtx = radarCanvas ? radarCanvas.getContext('2d') : null;
  var _radarData = { leader: null, minions: [], threats: [], enemies: [] };
  var RADAR_RANGE = 128; // blocks radius shown on radar

  // ── Parse position from string "x, y, z" or object ─────────────────────
  function parsePosition(posStr) {
    if (!posStr) return null;
    if (typeof posStr === 'object' && posStr.x !== undefined) return posStr;
    if (typeof posStr !== 'string') return null;
    var parts = posStr.match(/-?\d+(\.\d+)?/g);
    if (!parts || parts.length < 3) return null;
    return { x: parseFloat(parts[0]), y: parseFloat(parts[1]), z: parseFloat(parts[2]) };
  }

  // ── Radar draw ───────────────────────────────────────────────────────────
  function drawRadar() {
    if (!radarCtx) return;
    var W  = radarCanvas.width;
    var H  = radarCanvas.height;
    var cx = W / 2;
    var cy = H / 2;
    var r  = W / 2 - 2;
    var t  = Date.now();

    radarCtx.clearRect(0, 0, W, H);

    // ── Background ──────────────────────────────────────────────────────────
    radarCtx.save();
    radarCtx.beginPath();
    radarCtx.arc(cx, cy, r, 0, Math.PI * 2);

    // Radial background gradient
    var bgGrad = radarCtx.createRadialGradient(cx, cy, 0, cx, cy, r);
    bgGrad.addColorStop(0,   'rgba(0,30,20,0.92)');
    bgGrad.addColorStop(0.7, 'rgba(0,12,10,0.95)');
    bgGrad.addColorStop(1,   'rgba(0,5,5,0.98)');
    radarCtx.fillStyle = bgGrad;
    radarCtx.fill();
    radarCtx.clip();

    // ── Grid rings ──────────────────────────────────────────────────────────
    [0.25, 0.5, 0.75, 1.0].forEach(function (frac, i) {
      radarCtx.beginPath();
      radarCtx.arc(cx, cy, r * frac, 0, Math.PI * 2);
      radarCtx.strokeStyle = i === 3
        ? 'rgba(0,255,255,0.18)'
        : 'rgba(0,255,255,0.07)';
      radarCtx.lineWidth = i === 3 ? 1.5 : 0.8;
      radarCtx.stroke();
    });

    // Cross-hairs
    radarCtx.strokeStyle = 'rgba(0,255,255,0.10)';
    radarCtx.lineWidth = 0.8;
    radarCtx.setLineDash([4, 6]);
    radarCtx.beginPath();
    radarCtx.moveTo(cx, cy - r); radarCtx.lineTo(cx, cy + r);
    radarCtx.moveTo(cx - r, cy); radarCtx.lineTo(cx + r, cy);
    radarCtx.stroke();
    radarCtx.setLineDash([]);

    // ── Rotating sweep ──────────────────────────────────────────────────────
    var sweepAngle = (t / 2200) * Math.PI * 2;
    radarCtx.save();
    radarCtx.translate(cx, cy);
    radarCtx.rotate(sweepAngle);

    // Sweep cone (fan-shape gradient)
    var fanWidth = 0.55;
    var sweepGrad = radarCtx.createLinearGradient(0, 0, r, 0);
    sweepGrad.addColorStop(0,   'rgba(0,255,180,0.38)');
    sweepGrad.addColorStop(0.6, 'rgba(0,255,120,0.18)');
    sweepGrad.addColorStop(1,   'rgba(0,255,100,0)');
    radarCtx.beginPath();
    radarCtx.moveTo(0, 0);
    radarCtx.arc(0, 0, r, -fanWidth / 2, fanWidth / 2);
    radarCtx.closePath();
    radarCtx.fillStyle = sweepGrad;
    radarCtx.fill();

    // Bright leading edge line
    radarCtx.beginPath();
    radarCtx.moveTo(0, 0);
    radarCtx.lineTo(r, 0);
    radarCtx.strokeStyle = 'rgba(0,255,200,0.65)';
    radarCtx.lineWidth = 1.5;
    radarCtx.stroke();

    radarCtx.restore();

    // ── Helper: world to radar pixel ────────────────────────────────────────
    function worldToRadar(dx, dz) {
      return {
        x: cx + (dx / RADAR_RANGE) * r,
        y: cy + (dz / RADAR_RANGE) * r
      };
    }

    function inBounds(p) {
      var dx = p.x - cx;
      var dy = p.y - cy;
      return dx * dx + dy * dy <= r * r;
    }

    var leaderPos = _radarData.leader;

    // ── Danger zone threat rings (red pulsing) ──────────────────────────────
    _radarData.threats.forEach(function (threat) {
      if (!leaderPos || !threat) return;
      var dx = threat.x - leaderPos.x;
      var dz = threat.z - leaderPos.z;
      var p = worldToRadar(dx, dz);
      if (!inBounds(p)) return;

      // Outer pulsing ring
      var pulse = 0.45 + 0.55 * Math.abs(Math.sin(t / 500 + threat.x * 0.1));
      radarCtx.beginPath();
      radarCtx.arc(p.x, p.y, 9 + 4 * pulse, 0, Math.PI * 2);
      radarCtx.strokeStyle = 'rgba(255,49,95,' + (0.18 * pulse).toFixed(2) + ')';
      radarCtx.lineWidth = 1.5;
      radarCtx.stroke();

      // Inner core dot
      radarCtx.beginPath();
      radarCtx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      radarCtx.fillStyle = '#ff315f';
      radarCtx.shadowColor = '#ff315f';
      radarCtx.shadowBlur = 10 + 6 * pulse;
      radarCtx.fill();
      radarCtx.shadowBlur = 0;
    });

    // ── Known enemies (orange, smaller) ────────────────────────────────────
    _radarData.enemies.forEach(function (enemy) {
      if (!leaderPos || !enemy || !enemy.pos) return;
      var pos = parsePosition(enemy.pos);
      if (!pos) return;
      var dx = pos.x - leaderPos.x;
      var dz = pos.z - leaderPos.z;
      var p = worldToRadar(dx, dz);
      if (!inBounds(p)) return;

      var pulse2 = 0.5 + 0.5 * Math.abs(Math.sin(t / 700 + pos.z * 0.08));
      radarCtx.beginPath();
      radarCtx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      radarCtx.fillStyle = '#ff8c00';
      radarCtx.shadowColor = '#ff8c00';
      radarCtx.shadowBlur = 8 + 4 * pulse2;
      radarCtx.fill();
      radarCtx.shadowBlur = 0;
    });

    // ── Minion bots (cyan) ──────────────────────────────────────────────────
    _radarData.minions.forEach(function (pos) {
      if (!leaderPos || !pos) return;
      var dx = pos.x - leaderPos.x;
      var dz = pos.z - leaderPos.z;
      var p = worldToRadar(dx, dz);
      if (!inBounds(p)) return;

      radarCtx.beginPath();
      radarCtx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      radarCtx.fillStyle = '#00ffff';
      radarCtx.shadowColor = '#00ffff';
      radarCtx.shadowBlur = 9;
      radarCtx.fill();
      radarCtx.shadowBlur = 0;

      // Minion label tick
      radarCtx.beginPath();
      radarCtx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      radarCtx.strokeStyle = 'rgba(0,255,255,0.25)';
      radarCtx.lineWidth = 0.8;
      radarCtx.stroke();
    });

    // ── Leader (bright green, center) ───────────────────────────────────────
    if (leaderPos) {
      // Outer ring
      radarCtx.beginPath();
      radarCtx.arc(cx, cy, 10, 0, Math.PI * 2);
      radarCtx.strokeStyle = 'rgba(57,255,20,0.30)';
      radarCtx.lineWidth = 1;
      radarCtx.stroke();

      // Core
      radarCtx.beginPath();
      radarCtx.arc(cx, cy, 5.5, 0, Math.PI * 2);
      radarCtx.fillStyle = '#39FF14';
      radarCtx.shadowColor = '#39FF14';
      radarCtx.shadowBlur = 16;
      radarCtx.fill();
      radarCtx.shadowBlur = 0;
    }

    radarCtx.restore();

    // Update canvas border glow when threats present
    if (radarCanvas) {
      if (_radarData.threats.length > 0 || _radarData.enemies.length > 0) {
        radarCanvas.classList.add('threat-active');
      } else {
        radarCanvas.classList.remove('threat-active');
      }
    }
  }

  // ── Data fetching ────────────────────────────────────────────────────────
  async function fetchRadarData() {
    // Fleet minion positions
    try {
      var rf = await fetch('/bot-api/fleet/status', { cache: 'no-store' });
      if (rf.ok) {
        var df = await rf.json();
        var minions = [];
        (df.bots || []).forEach(function (b) {
          if (b.position) {
            var p = parsePosition(b.position);
            if (p) minions.push(p);
          }
        });
        _radarData.minions = minions;
      }
    } catch (_) {}

    // Leader position
    try {
      var rs = await fetch('/bot-api/status', { cache: 'no-store' });
      if (rs.ok) {
        var ds = await rs.json();
        if (ds.position) _radarData.leader = parsePosition(ds.position);
      }
    } catch (_) {}

    // Hive threats: danger zones + known enemies
    try {
      var rh = await fetch('/bot-api/hive/status', { cache: 'no-store' });
      if (rh.ok) {
        var dh = await rh.json();
        var hive = dh.hive || dh;

        // Danger zones — stored as {x, y, z, reason}
        var zones = hive.dangerZones || hive.danger_zones || [];
        _radarData.threats = zones.map(function (z) {
          return { x: z.x, y: z.y, z: z.z };
        });

        // Known enemies — stored as {name, pos, lastSeen}
        var enemies = hive.enemies || hive.knownEnemies || [];
        _radarData.enemies = enemies;
      }
    } catch (_) {}
  }

  // ── Radar animation loop ─────────────────────────────────────────────────
  function radarLoop() {
    drawRadar();
    requestAnimationFrame(radarLoop);
  }

  if (radarCtx) {
    radarLoop();
    fetchRadarData();
    setInterval(function () { if (!document.hidden) fetchRadarData(); }, 3000);

    // Live leader position from socket
    if (typeof socket !== 'undefined') {
      socket.on('status', function (data) {
        if (data && data.position) {
          var p = parsePosition(data.position);
          if (p) _radarData.leader = p;
        }
      });

      // Live hive intel: threat updates
      socket.on('hive:update', function (data) {
        if (!data) return;
        if (data.dangerZones) {
          _radarData.threats = data.dangerZones.map(function (z) {
            return { x: z.x, y: z.y, z: z.z };
          });
        }
        if (data.enemies) {
          _radarData.enemies = data.enemies;
        }
      });

      // Tactical socket events that signal enemy contact
      socket.on('tactical:engage', function (data) {
        // Flash the radar border on combat start
        if (radarCanvas) {
          radarCanvas.classList.add('threat-active');
        }
      });
    }
  }

  // ── Formation toggle buttons ────────────────────────────────────────────
  var formationBtns = document.querySelectorAll('.formation-btn[data-formation]');

  formationBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var formation = btn.dataset.formation;
      // Visual: mark active
      formationBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      // Emit fleet formation command
      if (typeof socket !== 'undefined') {
        socket.emit('fleet:command', { command: 'formation', formation: formation });
      }
      // Also call REST endpoint
      fetch('/bot-api/tactical/formation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formation: formation })
      }).catch(function () {});
    });
  });

  // ── Macro buttons ───────────────────────────────────────────────────────
  var macroRetreatBtn = document.getElementById('macroRetreat');
  var macroEngageBtn  = document.getElementById('macroEngage');
  var macroRtbBtn     = document.getElementById('macroRtb');

  function emitFleetCmd(command, extra) {
    if (typeof socket !== 'undefined') {
      socket.emit('fleet:command', Object.assign({ command: command }, extra || {}));
    }
  }

  function flashBtn(btn, ms) {
    if (!btn) return;
    btn.disabled = true;
    setTimeout(function () { btn.disabled = false; }, ms || 1200);
  }

  if (macroRetreatBtn) {
    macroRetreatBtn.addEventListener('click', function () {
      emitFleetCmd('abort');
      emitFleetCmd('stop');
      fetch('/bot-api/tactical/abort', { method: 'POST' }).catch(function () {});
      flashBtn(macroRetreatBtn, 2000);
      if (typeof appendLog === 'function') {
        appendLog({ at: new Date().toISOString(), message: '[MACRO] Emergency Retreat — all bots aborting combat' });
      }
    });
  }

  if (macroEngageBtn) {
    macroEngageBtn.addEventListener('click', function () {
      fetch('/bot-api/tactical/engage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }).catch(function () {});
      emitFleetCmd('engage');
      flashBtn(macroEngageBtn, 1500);
      if (typeof appendLog === 'function') {
        appendLog({ at: new Date().toISOString(), message: '[MACRO] Engage All — fleet entering combat' });
      }
    });
  }

  if (macroRtbBtn) {
    macroRtbBtn.addEventListener('click', function () {
      emitFleetCmd('follow');
      flashBtn(macroRtbBtn, 1500);
      if (typeof appendLog === 'function') {
        appendLog({ at: new Date().toISOString(), message: '[MACRO] Return to Base — all bots following leader' });
      }
    });
  }

  // ── Sidebar mobile toggle ───────────────────────────────────────────────
  var sidebarToggle = document.getElementById('sidebarToggle');
  var sidebar       = document.getElementById('sidebar');

  if (sidebarToggle && sidebar) {
    sidebarToggle.addEventListener('click', function () {
      sidebar.classList.toggle('open');
    });
    // Close sidebar when clicking outside on mobile
    document.addEventListener('click', function (e) {
      if (sidebar.classList.contains('open') &&
          !sidebar.contains(e.target) &&
          e.target !== sidebarToggle) {
        sidebar.classList.remove('open');
      }
    });
  }

})();
