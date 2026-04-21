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
  if (els.passInput.value === 'FaeroFTR') {
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
        const res = await fetch('/bot-api/roles/tier?id=' + encodeURIComponent(_userIdentity), { cache: 'no-store' });
        const data = await res.json();
        _userTier = data.tier || 0;
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
