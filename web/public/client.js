const socket = io({
  transports: ['websocket'],
  reconnectionAttempts: 5,
  timeout: 10000
});

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
  socket.emit('command', {
    command: 'mine_block',
    args: { block: document.getElementById('block').value.trim() }
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

socket.on('status', renderStatus);
socket.on('log', appendLog);
socket.on('chatLog', appendChatLog);
socket.on('thought', renderThought);
socket.on('errorMessage', (message) => {
  appendLog({ at: new Date().toISOString(), message: 'Error: ' + message });
  appendChatLog({ username: 'bot', message });
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && panelUnlocked) fetchRuntimeMetrics();
});

function unlockPanel() {
  if (els.passInput.value === 'FaeroFTR') {
    els.lockScreen.classList.add('hidden');
    els.mainContent.classList.add('unlocked');
    els.passInput.value = '';
    els.errorMsg.classList.remove('visible');
    panelUnlocked = true;
    startRuntimeMetrics();
    fetchConfig();
  } else {
    els.errorMsg.classList.add('visible');
    els.passInput.value = '';
  }
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
  if (!metrics) {
    els.cpuUsage.textContent = '-';
    els.ramUsage.textContent = '-';
    els.runtimeStatus.textContent = 'unavailable';
    return;
  }
  els.cpuUsage.textContent = value(metrics.cpuPercent) + '%';
  els.ramUsage.textContent = value(metrics.ramMb) + ' MB';
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

function renderStatus(status) {
  if (typeof status.aiModeEnabled === 'boolean' && status.aiModeEnabled !== aiModeEnabled) {
    aiModeEnabled = status.aiModeEnabled;
    updateAiModeDisplay(aiModeEnabled);
  }
  if (typeof status.lowPowerMode === 'boolean' && status.lowPowerMode !== lowPowerMode) {
    lowPowerMode = status.lowPowerMode;
    updateLowPowerButton(lowPowerMode);
  }
  els.running.textContent = status.running ? 'ONLINE' : 'OFFLINE';
  els.running.classList.toggle('online', Boolean(status.running));
  els.health.textContent = value(status.health);
  els.hunger.textContent = value(status.hunger);
  els.position.textContent = status.position ? status.position.x + ', ' + status.position.y + ', ' + status.position.z : '-';
  els.state.textContent = status.state ? status.state.reason || status.state.state : 'idle';
  els.connectionReadout.textContent = status.running && status.username ? 'Connected as ' + status.username : 'Awaiting connection';
  if (Array.isArray(status.logs) && status.logs.length !== renderedLogCount) {
    els.logs.innerHTML = '';
    renderedLogCount = status.logs.length;
    status.logs.forEach(appendLogLineOnly);
    els.logs.scrollTop = els.logs.scrollHeight;
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

function appendLog(entry) {
  renderedLogCount += 1;
  appendLogLineOnly(entry);
  els.logs.scrollTop = els.logs.scrollHeight;
}

function appendLogLineOnly(entry) {
  const line = document.createElement('div');
  line.className = 'log-line';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(entry.at).toLocaleTimeString();
  const msg = document.createElement('span');
  msg.textContent = entry.message;
  line.appendChild(time);
  line.appendChild(msg);
  els.logs.appendChild(line);
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
