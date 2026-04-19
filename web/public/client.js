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
  const connection = {
    host: els.host.value.trim() || undefined,
    port: els.port.value ? Number(els.port.value) : undefined,
    username: els.username.value.trim() || undefined,
    auth: els.auth.value.trim() || undefined
  };
  appendLog({ at: new Date().toISOString(), message: 'Connecting to ' + (connection.host || 'localhost') + ':' + (connection.port || 25565) + ' as ' + (connection.username || 'AI_Bot') });
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
