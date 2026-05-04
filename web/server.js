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

// ── Schematic Session Store ───────────────────────────────────────────────────
// In-memory store of custom schematics uploaded via the Schematic Lab panel.
// Session-scoped (resets on process restart). Max 20 entries, 128 KB each.
const _schematicStore   = new Map(); // id → entry object
let _schematicNextId    = 1;
const MAX_SCHEMATICS    = 20;
const MAX_SCHEMA_BYTES  = 128 * 1024;

function _validateSchematic(rawInput, nameOverride) {
  const autoBuild = require('../modules/autoBuild');
  let jsonData;
  if (typeof rawInput === 'string') {
    if (rawInput.length > MAX_SCHEMA_BYTES) {
      throw new Error('Schematic JSON exceeds max size (' + Math.round(MAX_SCHEMA_BYTES / 1024) + ' KB)');
    }
    try { jsonData = JSON.parse(rawInput); } catch (e) { throw new Error('Invalid JSON: ' + e.message); }
  } else if (rawInput && typeof rawInput === 'object') {
    jsonData = rawInput;
  } else {
    throw new Error('Provide a "json" field containing the schematic data');
  }

  const { blocks, name } = autoBuild.parseSchematic(jsonData, { x: 0, y: 0, z: 0 });
  const finalName = (nameOverride && String(nameOverride).trim()) || name;

  const blockCounts = {};
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const b of blocks) {
    blockCounts[b.type] = (blockCounts[b.type] || 0) + 1;
    if (b.x < minX) minX = b.x; if (b.x > maxX) maxX = b.x;
    if (b.y < minY) minY = b.y; if (b.y > maxY) maxY = b.y;
    if (b.z < minZ) minZ = b.z; if (b.z > maxZ) maxZ = b.z;
  }
  const dimensions = { sizeX: maxX - minX + 1, sizeY: maxY - minY + 1, sizeZ: maxZ - minZ + 1 };

  return { name: finalName, jsonData, totalBlocks: blocks.length, uniqueTypes: Object.keys(blockCounts).length, blockCounts, dimensions };
}

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

  const NO_CACHE = 'no-store, no-cache, must-revalidate, proxy-revalidate';
  const publicDir = path.join(__dirname, 'public');
  ['/manifest.json', '/sw.js', '/faero-icon.png', '/faero-icon-512.png'].forEach((file) => {
    app.get(file, (req, res) => {
      res.setHeader('Cache-Control', NO_CACHE);
      res.setHeader('Pragma', 'no-cache');
      res.sendFile(path.join(publicDir, file));
    });
  });

  app.use(express.static(publicDir, {
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
  let _lastConnOptions = {};
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
        _lastConnOptions = req.body || {};
        await botManager.createBot(_lastConnOptions);
        res.json({ ok: true, status: botManager.getStatus() });
      } catch (err) {
        res.status(400).json({ ok: false, error: err.message });
      }
    });
  });

  ['/api/reconnect', '/bot-api/reconnect'].forEach((route) => {
    app.post(route, async (req, res) => {
      try {
        botManager.stop();
        await new Promise(r => setTimeout(r, 600));
        await botManager.createBot(_lastConnOptions);
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
        const command = String((req.body && req.body.command) || '').trim();
        const args = req.body && req.body.args;
        if (!command) throw new Error('Command name is required');
        if (botManager.commands.has(command)) {
          botManager.executeCommand(command, Array.isArray(args) ? args : []);
        } else {
          botManager.runWebCommand(command, args && !Array.isArray(args) ? args : {});
        }
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

  // ── Waypoints (persistent named locations, MongoDB-backed) ─────────────
  const wpModels = require('../lib/persistence/models');
  const wpRoles  = require('../config/roles');
  const wpMongo  = require('../lib/persistence/mongo');
  const wpOwner  = () => wpRoles.getConfig().ownerMcName || 'faero';
  const wpName   = (raw) => {
    const s = String(raw || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(s)) return null;
    return s;
  };
  const wpErr = (res, code, message) => res.status(code).json({
    ok: false,
    error: { code: code === 404 ? 'WAYPOINT_NOT_FOUND' : code === 400 ? 'WAYPOINT_INVALID' : 'WAYPOINT_ERROR',
             title: code === 404 ? 'Waypoint Not Found' : code === 400 ? 'Invalid Request' : 'Waypoint System Error',
             message, color: '#FF1F1F' }
  });

  app.get('/bot-api/waypoints', async (req, res) => {
    if (!wpMongo.isReady()) return wpErr(res, 503, 'Persistence offline — waypoints unavailable in Local-Only Mode.');
    const list = await wpModels.listLocations(wpOwner());
    res.json({ ok: true, owner: wpOwner(), waypoints: list.map(w => ({
      label: w.label, x: w.x, y: w.y, z: w.z, dimension: w.dimension, updatedAt: w.updatedAt
    }))});
  });

  app.post('/bot-api/waypoints', async (req, res) => {
    if (!wpMongo.isReady()) return wpErr(res, 503, 'Persistence offline — waypoints cannot be saved.');
    const name = wpName(req.body && req.body.name);
    if (!name) return wpErr(res, 400, 'Waypoint name must be 1-32 chars: a-z, 0-9, _ or -.');
    const bot = botManager.bot;
    if (!bot || !bot.entity) return wpErr(res, 409, 'Bot is offline — cannot capture current coordinates.');
    const pos = bot.entity.position;
    const ok = await wpModels.upsertLocation({ owner: wpOwner(), label: name, x: pos.x, y: pos.y, z: pos.z });
    if (!ok) return wpErr(res, 500, 'Persistence write failed for waypoint [' + name + '].');
    res.json({ ok: true, waypoint: { label: name, x: pos.x, y: pos.y, z: pos.z } });
  });

  app.delete('/bot-api/waypoints/:name', async (req, res) => {
    if (!wpMongo.isReady()) return wpErr(res, 503, 'Persistence offline — cannot delete waypoint.');
    const name = wpName(req.params.name);
    if (!name) return wpErr(res, 400, 'Invalid waypoint name.');
    const r = await wpModels.deleteLocation(wpOwner(), name);
    if (!r.ok) return wpErr(res, 404, 'Waypoint [' + name + '] does not exist.');
    res.json({ ok: true, deleted: name });
  });

  app.post('/bot-api/waypoints/:name/go', async (req, res) => {
    if (!wpMongo.isReady()) return wpErr(res, 503, 'Persistence offline — cannot resolve waypoint.');
    const name = wpName(req.params.name);
    if (!name) return wpErr(res, 400, 'Invalid waypoint name.');
    const wp = await wpModels.findLocation(wpOwner(), name);
    if (!wp) return wpErr(res, 404, 'Waypoint [' + name + '] does not exist.');
    const bot = botManager.bot;
    if (!bot || !bot.entity) return wpErr(res, 409, 'Bot is offline — cannot navigate to waypoint.');
    try {
      const pathfinding = require('../modules/pathfinding');
      pathfinding.goToCoords(bot, wp.x, wp.y, wp.z, 1).catch(() => {});
      botManager.log('[waypoint] Navigation started to [' + name + '] at ' + Math.round(wp.x) + ',' + Math.round(wp.y) + ',' + Math.round(wp.z));
      res.json({ ok: true, navigatingTo: { label: name, x: wp.x, y: wp.y, z: wp.z } });
    } catch (err) {
      wpErr(res, 500, 'Navigation failed: ' + err.message);
    }
  });

  // ── Death Log (MongoDB-backed) ─────────────────────────────────────────────
  app.get('/bot-api/deaths', async (req, res) => {
    const deathModels = require('../lib/persistence/models');
    const deathMongo  = require('../lib/persistence/mongo');
    if (!deathMongo.isReady()) return res.json({ ok: true, deaths: [], offline: true });
    const limit  = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const deaths = await deathModels.listDeaths(null, limit);
    res.json({ ok: true, deaths: deaths.map(d => ({
      id: String(d._id), x: d.x, y: d.y, z: d.z,
      dimension: d.dimension, cause: d.cause,
      recovered: d.recovered, at: d.at
    }))});
  });

  // ── Auto Build API ──────────────────────────────────────────────────────────
  const autoBuildMod = require('../modules/autoBuild');

  app.get('/bot-api/build/schematics', (req, res) => {
    const list = autoBuildMod.listSchematics();
    res.json({ ok: true, schematics: list });
  });

  app.get('/bot-api/build/status', (req, res) => {
    res.json({ ok: true, build: autoBuildMod.getBuildStatus() });
  });

  app.post('/bot-api/build/cancel', (req, res) => {
    const cancelled = autoBuildMod.cancelBuild();
    res.json({ ok: true, cancelled, message: cancelled ? 'Build cancelled.' : 'No active build.' });
  });

  app.post('/bot-api/build/run', async (req, res) => {
    const bot = botManager.bot;
    if (!bot || !bot.entity) {
      return res.status(409).json({ ok: false, error: 'Bot is offline or has not spawned yet.' });
    }

    const { name, schematic } = req.body || {};
    const input = name || schematic;
    if (!input) {
      return res.status(400).json({
        ok: false,
        error: 'Provide "name" (built-in schematic name) or "schematic" (object or JSON string).'
      });
    }

    // Validate + parse before accepting the request, so bad input fails fast
    let parsed;
    try {
      parsed = autoBuildMod.parseSchematic(input, bot.entity.position);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }

    botManager.log('[autoBuild] API: queued build "' + parsed.name + '" — ' + parsed.blocks.length + ' blocks');

    // Respond immediately — the build runs asynchronously via the task queue
    res.json({
      ok: true,
      message: 'Build "' + parsed.name + '" queued (' + parsed.blocks.length + ' blocks). Poll GET /bot-api/build/status for progress.',
      name: parsed.name,
      blocks: parsed.blocks.length
    });

    botManager.taskQueue.push('Build: ' + parsed.name, async () => {
      await autoBuildMod.executeBuild(bot, input, {
        onLog: (msg) => botManager.log(msg),
        onProgress: ({ placed, total, name: bName }) => {
          if (placed > 0 && placed % 5 === 0) {
            botManager.log('[autoBuild] ' + bName + ': ' + placed + '/' + total + ' placed');
          }
        },
        state:     botManager.stateManager,
        pullChest: true
      });
    }, { priority: 3 });
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

  // ── Role Management API ────────────────────────────────────────────────────

  const roles = require('../config/roles');

  app.get('/bot-api/roles', (req, res) => {
    const cfg = roles.getConfig();
    res.json({
      ok: true,
      ownerMcName: cfg.ownerMcName,
      ownerDiscordId: cfg.ownerDiscordId ? '(set)' : '',
      adminMcNames: cfg.adminMcNames,
      adminDiscordIds: cfg.adminDiscordIds,
      managerMcNames: cfg.managerMcNames,
      managerDiscordIds: cfg.managerDiscordIds
    });
  });

  app.get('/bot-api/roles/tier', (req, res) => {
    const id = String((req.query.id) || '').trim();
    if (!id) return res.json({ tier: 0, tierName: 'None' });
    const mcTier = roles.getMcTier(id);
    const discordTier = roles.getDiscordTier(id);
    const tier = Math.max(mcTier, discordTier);
    res.json({ tier, tierName: roles.tierName(tier) });
  });

  app.post('/bot-api/roles/add', (req, res) => {
    try {
      const { field, value, actorId } = req.body || {};
      if (!field || !value) throw new Error('field and value are required');
      const allowed = ['adminMcNames', 'adminDiscordIds', 'managerMcNames', 'managerDiscordIds'];
      if (!allowed.includes(field)) throw new Error('Invalid role field');

      const actorMcTier = roles.getMcTier(actorId || '');
      const actorDiscordTier = roles.getDiscordTier(actorId || '');
      const actorTier = Math.max(actorMcTier, actorDiscordTier);

      const isAdminField = field.startsWith('admin');
      if (isAdminField && actorTier < roles.TIERS.OWNER) {
        throw new Error('Only the Owner can add Admins');
      }
      if (!isAdminField && actorTier < roles.TIERS.ADMIN) {
        throw new Error('Admin or Owner role required to add Managers');
      }

      const added = roles.addToRole(field, value.trim());
      res.json({ ok: true, added });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post('/bot-api/roles/remove', (req, res) => {
    try {
      const { field, value, actorId } = req.body || {};
      if (!field || !value) throw new Error('field and value are required');
      const allowed = ['adminMcNames', 'adminDiscordIds', 'managerMcNames', 'managerDiscordIds'];
      if (!allowed.includes(field)) throw new Error('Invalid role field');

      const actorMcTier = roles.getMcTier(actorId || '');
      const actorDiscordTier = roles.getDiscordTier(actorId || '');
      const actorTier = Math.max(actorMcTier, actorDiscordTier);

      const isAdminField = field.startsWith('admin');
      if (isAdminField && actorTier < roles.TIERS.OWNER) {
        throw new Error('Only the Owner can remove Admins');
      }
      if (!isAdminField && actorTier < roles.TIERS.ADMIN) {
        throw new Error('Admin or Owner role required to remove Managers');
      }

      const removed = roles.removeFromRole(field, value.trim());
      res.json({ ok: true, removed });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // ── AI Brain status ────────────────────────────────────────────────────────
  app.get('/bot-api/ai/status', (req, res) => {
    const llmClient   = require('../ai/llmClient');
    const goalPlanner = require('../ai/goalPlanner');
    res.json({
      ok:           true,
      provider:     llmClient.getProviderInfo(),
      llmChatEnabled: Boolean(botManager.llmChatEnabled),
      goal:         goalPlanner.getGoalStatus()
    });
  });

  app.post('/bot-api/ai/goal', (req, res) => {
    try {
      const goalText = String((req.body && req.body.goal) || '').trim();
      const stop     = Boolean(req.body && req.body.stop);
      const goalPlanner = require('../ai/goalPlanner');
      if (stop || !goalText) {
        const ctx = botManager.getContext && botManager.getContext();
        if (ctx) goalPlanner.clearGoal(ctx);
        return res.json({ ok: true, cleared: true });
      }
      const ctx = botManager.getContext && botManager.getContext();
      if (!ctx || !ctx.bot || !ctx.bot.entity) {
        return res.status(409).json({ ok: false, error: 'Bot is offline' });
      }
      goalPlanner.setGoal(ctx, goalText, (msg) => {
        try { ctx.bot.chat('[FAERO]: ' + msg); } catch (_) {}
      });
      res.json({ ok: true, goal: goalText });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post('/bot-api/ai/chat', (req, res) => {
    const enabled = Boolean(req.body && req.body.enabled);
    botManager.llmChatEnabled = enabled;
    io.emit('ai_chat_state', { llmChatEnabled: enabled });
    res.json({ ok: true, llmChatEnabled: enabled });
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

  // ── Fleet Manager API ──────────────────────────────────────────────────────
  const fleetMgr = require('../core/fleetManager');
  fleetMgr.init(botManager);

  app.get('/bot-api/fleet/status', (req, res) => {
    res.json({ ok: true, fleet: fleetMgr.getStatus() });
  });

  app.get('/bot-api/fleet/inventory', (req, res) => {
    res.json({ ok: true, ...fleetMgr.getInventories() });
  });

  app.post('/bot-api/fleet/spawn', (req, res) => {
    try {
      const opts = req.body || {};
      if (!opts.username) return res.status(400).json({ ok: false, error: '"username" is required' });
      const leaderConn = botManager.lastConnectionOptions || {};
      const id = fleetMgr.spawn({
        username: opts.username,
        host:     opts.host    || leaderConn.host    || process.env.MC_HOST    || 'localhost',
        port:     opts.port    || leaderConn.port    || process.env.MC_PORT    || 25565,
        auth:     opts.auth    || leaderConn.auth    || process.env.MC_AUTH    || 'offline',
        version:  opts.version || leaderConn.version
      });
      res.json({ ok: true, id, username: opts.username });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post('/bot-api/fleet/dismiss-all', (req, res) => {
    fleetMgr.dismissAll();
    res.json({ ok: true });
  });

  app.post('/bot-api/fleet/dismiss/:id', (req, res) => {
    try {
      fleetMgr.dismiss(req.params.id);
      res.json({ ok: true, dismissed: req.params.id });
    } catch (err) {
      res.status(404).json({ ok: false, error: err.message });
    }
  });

  app.post('/bot-api/fleet/command', (req, res) => {
    const { cmd, target } = req.body || {};
    if (!cmd) return res.status(400).json({ ok: false, error: '"cmd" is required' });
    try {
      fleetMgr.groupCommand(String(cmd), target ? String(target) : null);
      res.json({ ok: true, cmd, target: target || null });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post('/bot-api/fleet/build', (req, res) => {
    const input = req.body && (req.body.name || req.body.schematic);
    if (!input) return res.status(400).json({ ok: false, error: 'Provide "name" (built-in schematic) or "schematic" (JSON object)' });
    res.json({ ok: true, message: 'Distributed build started for "' + input + '" — check fleet:log events for progress' });
    fleetMgr.distributeBuild(input).catch((err) => {
      botManager.log('[fleet] Build error: ' + err.message);
    });
  });

  // ── Schematic Lab API ─────────────────────────────────────────────────────

  app.post('/bot-api/schematics/validate', (req, res) => {
    try {
      const raw  = req.body && (req.body.json || req.body.schematic);
      const name = (req.body && req.body.name) || '';
      if (!raw) return res.status(400).json({ ok: false, error: 'Provide a "json" field with schematic data' });
      const r = _validateSchematic(raw, name);
      res.json({ ok: true, name: r.name, totalBlocks: r.totalBlocks, uniqueTypes: r.uniqueTypes, blockCounts: r.blockCounts, dimensions: r.dimensions });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post('/bot-api/schematics/save', (req, res) => {
    try {
      const raw  = req.body && (req.body.json || req.body.schematic);
      const name = (req.body && req.body.name) || '';
      if (!raw) return res.status(400).json({ ok: false, error: 'Provide a "json" field with schematic data' });
      if (_schematicStore.size >= MAX_SCHEMATICS) {
        const oldestKey = _schematicStore.keys().next().value;
        _schematicStore.delete(oldestKey);
      }
      const v  = _validateSchematic(raw, name);
      const id = 'schema_' + (_schematicNextId++);
      _schematicStore.set(id, { id, name: v.name, jsonData: v.jsonData, blockCounts: v.blockCounts, totalBlocks: v.totalBlocks, uniqueTypes: v.uniqueTypes, dimensions: v.dimensions, savedAt: new Date().toISOString() });
      res.json({ ok: true, id, name: v.name, totalBlocks: v.totalBlocks });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.get('/bot-api/schematics', (req, res) => {
    const list = Array.from(_schematicStore.values()).map((s) => ({
      id: s.id, name: s.name, totalBlocks: s.totalBlocks, uniqueTypes: s.uniqueTypes,
      blockCounts: s.blockCounts, dimensions: s.dimensions, savedAt: s.savedAt
    }));
    res.json({ ok: true, schematics: list, total: list.length });
  });

  app.delete('/bot-api/schematics/:id', (req, res) => {
    const id = req.params.id;
    if (!_schematicStore.has(id)) return res.status(404).json({ ok: false, error: 'Schematic not found' });
    _schematicStore.delete(id);
    res.json({ ok: true, deleted: id });
  });

  app.post('/bot-api/schematics/:id/deploy', (req, res) => {
    const entry = _schematicStore.get(req.params.id);
    if (!entry) return res.status(404).json({ ok: false, error: 'Schematic not found — it may have been removed' });
    res.json({ ok: true, message: 'Deploying "' + entry.name + '" (' + entry.totalBlocks + ' blocks) across fleet — check the log for progress' });
    fleetMgr.distributeBuild(entry.jsonData).catch((err) => {
      botManager.log('[schematics] Deploy failed for "' + entry.name + '": ' + err.message);
    });
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