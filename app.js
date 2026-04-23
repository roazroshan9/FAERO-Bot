/**
 * FAERO Minecraft AI Bot — Main entry point
 *
 * This application is for personal, non-commercial use only.
 * It performs no unauthorized network scanning, no packet manipulation,
 * and no activity that violates Replit's Terms of Service or standard
 * Minecraft server policies.
 *
 * See README.md for full usage and compliance notes.
 */

'use strict';

// Load .env file if present (no-op when missing). Replit Secrets always win.
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const botManager      = require('./core/botManager');
const ProcessManager  = require('./core/processManager');
const ResourceMonitor = require('./core/monitor');
const EmergencyMonitor = require('./core/emergencyMonitor');
const { createWebServer } = require('./web/server');
const DiscordBridge   = require('./discord/client');
const mongo           = require('./lib/persistence/mongo');
const models          = require('./lib/persistence/models');
const roles           = require('./config/roles');

const port = Number(process.env.WEB_PORT || process.env.PORT || 3000);
const web  = createWebServer({ botManager });

const processManager = new ProcessManager({
  botManager,
  server:   web.server,
  closeWeb: (done) => web.close(done)
});

const discordBridge   = new DiscordBridge(botManager);
const monitor         = new ResourceMonitor(botManager);
const emergency       = new EmergencyMonitor(botManager);

discordBridge._monitor   = monitor;
discordBridge._emergency = emergency;
botManager._emergency    = emergency;

monitor.on('alert', (msg) => discordBridge.sendAlert(msg));
emergency.on('alert', (payload) => {
  discordBridge.sendEmergencyAlert(payload);
  models.writeLog({
    type: 'alert', level: 'critical', actor: 'emergency-monitor',
    message: payload.message, meta: { reason: payload.reason, ...payload.meta }
  }).catch(() => {});
});

// ── Persistence bootstrap (non-blocking) ─────────────────────────────────────
mongo.connect((line) => botManager.log(line)).then((ok) => {
  if (ok) {
    models.syncRoleSnapshot(roles.getConfig()).catch(() => {});
    botManager.log('[mongo] Persistence layer ready — UserRoles / SavedLocations / Logs available');
  } else {
    botManager.log('[mongo] Local-Only Mode active — bot remains fully functional without DB');
  }
});

processManager.start();
botManager.startAutoCleanup();
discordBridge.start();
monitor.start();
emergency.start();

web.listen(port).then(() => {
  botManager.log('Web control panel running on port ' + port);
  if (String(process.env.AUTO_START_BOT || '').toLowerCase() === 'true') {
    processManager.startBotFromEnvironment();
  }
}).catch((err) => {
  console.error('Failed to start web control panel:', err.message);
  process.exit(1);
});

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  emergency.stop();
  monitor.stop();
  discordBridge.stop();
  mongo.disconnect().catch(() => {});
  processManager.shutdown(() => process.exit(0));
}
