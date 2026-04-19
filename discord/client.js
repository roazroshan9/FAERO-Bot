const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');

const PREFIX = '!bot';

class DiscordBridge {
  constructor(botManager) {
    this.botManager = botManager;
    this.client = null;
    this.logChannelId = process.env.DISCORD_LOG_CHANNEL_ID || null;
    this.guildId = process.env.DISCORD_GUILD_ID || null;
    this._logListener = null;
  }

  start() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
      console.log('[discord] DISCORD_TOKEN not set — Discord bridge disabled');
      return;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    });

    this.client.once(Events.ClientReady, (c) => {
      console.log('[discord] Logged in as ' + c.user.tag);
      this.botManager.log('[discord] Bridge online as ' + c.user.tag);
    });

    this.client.on(Events.MessageCreate, (message) => {
      if (message.author.bot) return;
      if (!message.content.startsWith(PREFIX)) return;
      if (this.guildId && message.guildId !== this.guildId) return;
      this._handleMessage(message);
    });

    this._logListener = (entry) => this._forwardLog(entry);
    this.botManager.on('log', this._logListener);

    this.client.login(token).catch((err) => {
      console.error('[discord] Login failed: ' + err.message);
    });
  }

  _forwardLog(entry) {
    if (!this.logChannelId || !this.client || !this.client.isReady()) return;
    const ch = this.client.channels.cache.get(this.logChannelId);
    if (!ch || !ch.isTextBased()) return;
    const ts = new Date(entry.at).toLocaleTimeString('en-GB', { hour12: false });
    ch.send('`' + ts + '` ' + entry.message).catch(() => {});
  }

  _handleMessage(message) {
    const raw = message.content.slice(PREFIX.length).trim();
    const parts = raw.split(/\s+/);
    const cmd = (parts[0] || 'help').toLowerCase();
    const args = parts.slice(1);
    const bm = this.botManager;

    const reply = (text) => message.reply(text).catch(() => {});
    const replyEmbed = (embed) => message.reply({ embeds: [embed] }).catch(() => {});

    switch (cmd) {
      case 'help': {
        const embed = new EmbedBuilder()
          .setColor(0x39FF14)
          .setTitle('FAERO Bot — Command Reference')
          .setDescription('Prefix: `' + PREFIX + ' <command>`')
          .addFields(
            { name: '`status`', value: 'Full bot status report', inline: true },
            { name: '`health`', value: 'Health & hunger only', inline: true },
            { name: '`connect`', value: 'Connect to Minecraft server', inline: true },
            { name: '`disconnect`', value: 'Disconnect bot', inline: true },
            { name: '`follow`', value: 'Follow the authorized player', inline: true },
            { name: '`stop`', value: 'Stop current action', inline: true },
            { name: '`go <x> <y> <z>`', value: 'Move to coordinates', inline: true },
            { name: '`ai on|off`', value: 'Toggle AI brain', inline: true },
            { name: '`logs [n]`', value: 'Show last n log lines (max 10)', inline: true }
          )
          .setFooter({ text: 'FAERO Minecraft AI' });
        return replyEmbed(embed);
      }

      case 'status': {
        const s = bm.getStatus();
        const pos = s.position
          ? s.position.x + ', ' + s.position.y + ', ' + s.position.z
          : 'unknown';
        const embed = new EmbedBuilder()
          .setColor(s.running ? 0x39FF14 : 0xFF315F)
          .setTitle('Bot Status')
          .addFields(
            { name: '🟢 Online',   value: s.running ? 'Yes' : 'No',              inline: true },
            { name: '👤 Username', value: s.username || '-',                      inline: true },
            { name: '❤️ Health',   value: String(s.health ?? '-'),                inline: true },
            { name: '🍖 Hunger',   value: String(s.hunger ?? '-'),                inline: true },
            { name: '📍 Position', value: pos,                                    inline: true },
            { name: '⚡ State',    value: s.state ? s.state.state : 'idle',       inline: true },
            { name: '🤖 AI Mode',  value: s.aiModeEnabled ? 'ON' : 'OFF',         inline: true },
            { name: '🔋 Low Power',value: s.lowPowerMode ? 'ON' : 'OFF',          inline: true }
          )
          .setTimestamp();
        return replyEmbed(embed);
      }

      case 'health': {
        const s = bm.getStatus();
        return reply(
          '❤️ Health: **' + (s.health ?? '-') + '** | 🍖 Hunger: **' + (s.hunger ?? '-') + '**'
        );
      }

      case 'connect': {
        bm.createBot()
          .then(() => reply('✅ Bot connecting to **' + (process.env.MC_HOST || 'localhost') + '**…'))
          .catch((err) => reply('❌ Connect failed: ' + err.message));
        return;
      }

      case 'disconnect': {
        bm.stop();
        return reply('🔌 Bot disconnected.');
      }

      case 'follow': {
        if (!bm.bot) return reply('❌ Bot is offline.');
        try {
          bm.runWebCommand('follow', {});
          reply('👟 Following ' + (process.env.AUTHORIZED_USER || 'roaz') + '…');
        } catch (err) {
          reply('❌ ' + err.message);
        }
        return;
      }

      case 'stop': {
        try {
          bm.runWebCommand('stop', {});
          reply('⛔ Bot stopped.');
        } catch (err) {
          reply('❌ ' + err.message);
        }
        return;
      }

      case 'go': {
        const [x, y, z] = args.map(Number);
        if ([x, y, z].some((n) => !Number.isFinite(n))) {
          return reply('❌ Usage: `' + PREFIX + ' go <x> <y> <z>`');
        }
        try {
          bm.runWebCommand('go', { x, y, z });
          reply('🧭 Moving to **' + x + ', ' + y + ', ' + z + '**');
        } catch (err) {
          reply('❌ ' + err.message);
        }
        return;
      }

      case 'ai': {
        const on = (args[0] || '').toLowerCase() === 'on';
        bm.setAiMode(on);
        return reply('🤖 AI mode: **' + (on ? 'ON' : 'OFF') + '**');
      }

      case 'logs': {
        const n = Math.min(10, Math.max(1, parseInt(args[0], 10) || 5));
        const entries = bm.logs.slice(-n);
        if (!entries.length) return reply('No logs yet.');
        const lines = entries.map((e) => {
          const ts = new Date(e.at).toLocaleTimeString('en-GB', { hour12: false });
          return '`' + ts + '` ' + e.message;
        });
        return reply(lines.join('\n'));
      }

      default:
        return reply('❓ Unknown command. Type `' + PREFIX + ' help` to see all commands.');
    }
  }

  stop() {
    if (this._logListener) {
      this.botManager.off('log', this._logListener);
      this._logListener = null;
    }
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }
}

module.exports = DiscordBridge;
