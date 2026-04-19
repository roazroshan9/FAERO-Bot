const path = require('path');
const express = require('express');
const http = require('http');
const net = require('net');
const dns = require('dns');
const socketIo = require('socket.io');
const defaultBotManager = require('../core/botManager');
const attachSocket = require('./socket');

let lastCpuUsage = process.cpuUsage();
let lastCpuCheck = Date.now();

function createWebServer(options) {
  const botManager = options && options.botManager ? options.botManager : defaultBotManager;
  const app = express();
  const server = http.createServer(app);
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  const io = socketIo(server, {
    transports: ['websocket'],
    pingInterval: 25000,
    pingTimeout: 10000,
    maxHttpBufferSize: 32768,
    perMessageDeflate: false,
    httpCompression: false
  });

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
  }));

  mountRoutes(app, io, botManager);
  attachSocket(io, botManager);

  return {
    app,
    io,
    server,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          server.off('error', reject);
          resolve(server);
        });
      });
    },
    close(done) {
      io.close(() => {
        if (server.listening) {
          server.close(done);
        } else if (done) {
          done();
        }
      });
    }
  };
}

function mountRoutes(app, io, botManager) {
  app.get('/healthz', (req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()) });
  });

  app.get('/bot-api/runtime', (req, res) => {
    res.json(buildRuntimeMetrics(botManager));
  });

  app.get('/bot-api/config', (req, res) => {
    res.json(buildConfigSummary(botManager));
  });

  ['/api/status', '/bot-api/status'].forEach((route) => {
    app.get(route, (req, res) => {
      res.json(botManager.getStatus());
    });
  });

  ['/api/start', '/bot-api/start'].forEach((route) => {
    app.post(route, async (req, res) => {
      try {
        await botManager.createBot(req.body || {});
        res.json({ ok: true, status: botManager.getStatus() });
      } catch (err) {
        res.status(400).json({ ok: false, error: err.message });
      }
    });
  });

  ['/api/stop', '/bot-api/stop'].forEach((route) => {
    app.post(route, (req, res) => {
      botManager.stop();
      res.json({ ok: true, status: botManager.getStatus() });
    });
  });

  ['/api/command', '/bot-api/command'].forEach((route) => {
    app.post(route, (req, res) => {
      try {
        botManager.runWebCommand(req.body.command, req.body.args || {});
        res.json({ ok: true, status: botManager.getStatus() });
      } catch (err) {
        res.status(400).json({ ok: false, error: err.message });
      }
    });
  });

  app.post('/bot-api/force-cleanup', (req, res) => {
    botManager._runCleanup();
    res.json({ ok: true });
  });

  app.post('/bot-api/ai-mode', (req, res) => {
    const enabled = Boolean(req.body && req.body.enabled);
    botManager.setAiMode(enabled);
    res.json({ ok: true, aiModeEnabled: botManager.aiModeEnabled });
  });

  app.post('/bot-api/low-power-mode', (req, res) => {
    const enabled = Boolean(req.body && req.body.enabled);
    botManager.setLowPowerMode(enabled);
    res.json({ ok: true, lowPowerMode: botManager.lowPowerMode });
  });

  app.get('/bot-api/inventory', (req, res) => {
    res.json(botManager.getInventory());
  });

  app.post('/bot-api/test-proxy', async (req, res) => {
    const { SocksClient } = require('socks');
    const proxyUrl = String((req.body && req.body.proxy) || '').trim();
    const destHost = String((req.body && req.body.host) || 'google.com').trim();
    const destPort = Number((req.body && req.body.port) || 80);

    if (!proxyUrl) return res.status(400).json({ ok: false, error: 'Proxy URL is required' });

    let parsed;
    try { parsed = new URL(proxyUrl); } catch {
      return res.status(400).json({ ok: false, error: 'Invalid proxy URL — expected socks5://[user:pass@]host:port' });
    }
    if (!['socks5:', 'socks5h:', 'socks4:', 'socks4a:', 'socks:'].includes(parsed.protocol)) {
      return res.status(400).json({ ok: false, error: 'Unsupported proxy protocol — use socks5://' });
    }

    const steps = [];
    const proxyHost = parsed.hostname;
    const proxyPort = Number(parsed.port);

    const tcpStart = Date.now();
    try {
      await new Promise((resolve, reject) => {
        const sock = new (require('net').Socket)();
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('Timed out')); }, 6000);
        sock.connect(proxyPort, proxyHost, () => { clearTimeout(timer); sock.destroy(); resolve(); });
        sock.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
      steps.push({ label: 'PROXY REACHABLE', ok: true, detail: proxyHost + ':' + proxyPort + ' TCP OK', ms: Date.now() - tcpStart });
    } catch (err) {
      steps.push({ label: 'PROXY REACHABLE', ok: false, detail: err.message, ms: Date.now() - tcpStart });
      return res.json({ ok: false, steps });
    }

    const socksType = parsed.protocol.startsWith('socks4') ? 4 : 5;
    const proxyOpts = { host: proxyHost, port: proxyPort, type: socksType };
    if (parsed.username) proxyOpts.userId = decodeURIComponent(parsed.username);
    if (parsed.password) proxyOpts.password = decodeURIComponent(parsed.password);

    const tunnelStart = Date.now();
    try {
      const result = await SocksClient.createConnection({
        proxy: proxyOpts,
        command: 'connect',
        destination: { host: destHost, port: destPort }
      });
      result.socket.destroy();
      steps.push({ label: 'SOCKS5 TUNNEL', ok: true, detail: 'Tunneled to ' + destHost + ':' + destPort + ' OK', ms: Date.now() - tunnelStart });
    } catch (err) {
      steps.push({ label: 'SOCKS5 TUNNEL', ok: false, detail: err.message.replace(/password[^,)]*/gi, 'password=[redacted]'), ms: Date.now() - tunnelStart });
      return res.json({ ok: false, steps });
    }

    res.json({ ok: true, steps });
  });

  app.post('/bot-api/diagnostics', async (req, res) => {
    const host = String((req.body && req.body.host) || '').trim();
    const port = Number((req.body && req.body.port) || 25565);
    if (!host) return res.status(400).json({ ok: false, error: 'Host is required' });

    const results = { host, port, steps: [] };

    const dnsStart = Date.now();
    let resolvedIp = host;
    try {
      const addresses = await new Promise((resolve, reject) => {
        dns.resolve4(host, (err, addrs) => {
          if (err) reject(err);
          else resolve(addrs);
        });
      });
      resolvedIp = addresses[0];
      results.steps.push({ label: 'DNS', ok: true, detail: addresses.join(', '), ms: Date.now() - dnsStart });
    } catch (err) {
      results.steps.push({ label: 'DNS', ok: false, detail: err.code || err.message, ms: Date.now() - dnsStart });
      return res.json({ ok: false, results });
    }

    const tcpStart = Date.now();
    try {
      await new Promise((resolve, reject) => {
        const socket = new net.Socket();
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error('Connection timed out'));
        }, 6000);
        socket.connect(port, resolvedIp, () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve();
        });
        socket.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
      const tcpMs = Date.now() - tcpStart;
      results.steps.push({ label: 'TCP', ok: true, detail: resolvedIp + ':' + port + ' reachable', ms: tcpMs });
      results.steps.push({ label: 'Latency', ok: true, detail: tcpMs + 'ms round-trip', ms: tcpMs });
    } catch (err) {
      results.steps.push({ label: 'TCP', ok: false, detail: err.message, ms: Date.now() - tcpStart });
      results.steps.push({ label: 'Latency', ok: false, detail: 'N/A', ms: null });
    }

    res.json({ ok: true, results });
  });

  app.post('/bot-api/chat', (req, res) => {
    try {
      const message = String((req.body && req.body.message) || '').trim();
      const username = String((req.body && req.body.username) || process.env.AUTHORIZED_USER || 'roaz').trim();
      if (!message) throw new Error('Chat message cannot be empty');
      if (username !== (process.env.AUTHORIZED_USER || 'roaz') && !botManager.memory.isTrusted(username)) {
        throw new Error('Unauthorized chat user');
      }
      if (!botManager.bot || !botManager.bot.entity) {
        throw new Error('Bot is not running or has not spawned yet');
      }
      botManager.bot.chat(message);
      io.emit('chatLog', { username, message });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });
}

function buildConfigSummary(botManager) {
  return {
    botTickMs:              readEnvNum('BOT_TICK_MS', 10000),
    mobScanIntervalMs:      readEnvNum('MOB_SCAN_INTERVAL_MS', 15000),
    oreScanIntervalMs:      readEnvNum('ORE_SCAN_INTERVAL_MS', 120000),
    cpuLimitPercent:        readEnvNum('AI_CPU_LIMIT_PERCENT', 30),
    dangerWatchRange:       readEnvNum('DANGER_WATCH_RANGE', 5),
    dangerActionIntervalMs: readEnvNum('DANGER_ACTION_INTERVAL_MS', 20000),
    commandCooldownMs:      botManager.commandCooldownMs,
    survivalActionIntervalMs:  readEnvNum('SURVIVAL_ACTION_INTERVAL_MS', 45000),
    resourceActionIntervalMs:  readEnvNum('RESOURCE_ACTION_INTERVAL_MS', 120000),
    autoCleanupIntervalMs:  readEnvNum('AUTO_CLEANUP_INTERVAL_MS', 300000),
    memoryCleanupIntervalMs: readEnvNum('MEMORY_CLEANUP_INTERVAL_MS', 60000),
    maxRestarts:            readEnvNum('BOT_MAX_RESTARTS', 5),
    maxMemoryMb:            readEnvNum('NODE_MAX_OLD_SPACE_MB', 384)
  };
}

function readEnvNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function buildRuntimeMetrics(botManager) {
  const now = Date.now();
  const cpu = process.cpuUsage(lastCpuUsage);
  const elapsedMs = Math.max(1, now - lastCpuCheck);
  lastCpuUsage = process.cpuUsage();
  lastCpuCheck = now;

  const memory = process.memoryUsage();
  const cpuPercent = Math.min(100, Math.max(0, ((cpu.user + cpu.system) / 1000 / elapsedMs) * 100));
  const supervisor = botManager.processManager && botManager.processManager.getRuntimeSummary
    ? botManager.processManager.getRuntimeSummary()
    : { status: 'running', restartCount: 0, recentRestarts: 0, maxRestarts: 0 };

  return {
    status: supervisor.status,
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    ramMb: Math.round(memory.rss / 1024 / 1024),
    heapMb: Math.round(memory.heapUsed / 1024 / 1024),
    restartCount: supervisor.restartCount,
    recentRestarts: supervisor.recentRestarts,
    maxRestarts: supervisor.maxRestarts,
    uptimeSeconds: Math.round(process.uptime())
  };
}

function startStandalone() {
  const port = Number(process.env.WEB_PORT || process.env.PORT || 3000);
  const web = createWebServer({ botManager: defaultBotManager });
  web.listen(port).then(() => {
    defaultBotManager.log('Web control panel running on port ' + port);
  });
  return web;
}

if (require.main === module) {
  startStandalone();
}

module.exports = {
  createWebServer,
  startStandalone,
  buildRuntimeMetrics
};