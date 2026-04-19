const botManager = require('./core/botManager');
const ProcessManager = require('./core/processManager');
const { createWebServer } = require('./web/server');
const DiscordBridge = require('./discord/client');

const port = Number(process.env.WEB_PORT || process.env.PORT || 3000);
const web = createWebServer({ botManager });
const processManager = new ProcessManager({
  botManager,
  server: web.server,
  closeWeb: (done) => web.close(done)
});

const discordBridge = new DiscordBridge(botManager);

processManager.start();
botManager.startAutoCleanup();
discordBridge.start();

web.listen(port).then(() => {
  botManager.log('Web control panel running on port ' + port);
  if (String(process.env.AUTO_START_BOT || '').toLowerCase() === 'true') {
    processManager.startBotFromEnvironment();
  }
}).catch((err) => {
  console.error('Failed to start web control panel:', err.message);
  process.exit(1);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  discordBridge.stop();
  processManager.shutdown(() => process.exit(0));
}