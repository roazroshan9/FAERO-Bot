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

const botManager     = require('./core/botManager');
const ProcessManager = require('./core/processManager');
const ResourceMonitor = require('./core/monitor');
const { createWebServer } = require('./web/server');
const DiscordBridge  = require('./discord/client');

const port = Number(process.env.WEB_PORT || process.env.PORT || 3000);
const web  = createWebServer({ botManager });

const processManager = new ProcessManager({
  botManager,
  server:   web.server,
  closeWeb: (done) => web.close(done)
});

// Discord bridge and resource monitor
const discordBridge = new DiscordBridge(botManager);
const monitor       = new ResourceMonitor(botManager);

// Give the bridge a reference so !bot resources works and alerts are routed
discordBridge._monitor = monitor;
monitor.on('alert', (msg) => discordBridge.sendAlert(msg));

// Start all subsystems
processManager.start();
botManager.startAutoCleanup();
discordBridge.start();
monitor.start();

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
  monitor.stop();
  discordBridge.stop();
  processManager.shutdown(() => process.exit(0));
}
