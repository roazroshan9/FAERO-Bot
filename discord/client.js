/**
 * DiscordBridge — Discord bot integration for FAERO Minecraft Bot
 *
 * Prefix : !bot <command>
 * Security: Per-user rate limiting enforced on every command.
 * Compliance: No unauthorized network access. Commands map 1-to-1 with
 *   legitimate mineflayer gameplay actions only.
 *
 * Personal, non-commercial use only. See README.md.
 */

'use strict';

const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');

const PREFIX = '!bot';

// Per-user cooldown between Discord commands (ms). Prevents spam and keeps
// bot activity within Minecraft server anti-cheat tolerances.
const DISCORD_RATE_LIMIT_MS = Number(process.env.DISCORD_RATE_LIMIT_MS) || 3000;

class DiscordBridge {
  constructor(botManager) {
    this.botManager = botManager;
    this.client = null;
    this.logChannelId = process.env.DISCORD_LOG_CHANNEL_ID || null;
    this.guildId = process.env.DISCORD_GUILD_ID || null;
    this._logListener = null;
    // userId → timestamp of last accepted command
    this._userCooldowns = new Map();
    // Reference to the resource monitor (set by app.js after construction)
    this._monitor = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

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

      // ── Per-user rate limit ──────────────────────────────────────────────
      const userId = message.author.id;
      const now = Date.now();
      const lastAt = this._userCooldowns.get(userId) || 0;
      const elapsed = now - lastAt;
      if (elapsed < DISCORD_RATE_LIMIT_MS) {
        const waitSec = Math.ceil((DISCORD_RATE_LIMIT_MS - elapsed) / 1000);
        message.reply('⏳ Rate limit — wait **' + waitSec + 's** before the next command.').catch(() => {});
        return;
      }
      this._userCooldowns.set(userId, now);

      this._handleMessage(message);
    });

    this._logListener = (entry) => this._forwardLog(entry);
    this.botManager.on('log', this._logListener);

    this.client.login(token).catch((err) => {
      console.error('[discord] Login failed: ' + err.message);
    });
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

  // ── Public: send an alert to the log channel ──────────────────────────────
  // Used by the resource monitor and other system events.

  sendAlert(message) {
    if (!this.client || !this.client.isReady()) return;
    if (!this.logChannelId) return;
    const ch = this.client.channels.cache.get(this.logChannelId);
    if (!ch || !ch.isTextBased()) return;
    ch.send('⚠️ **FAERO ALERT:** ' + message).catch(() => {});
  }

  // ── Internal: forward bot logs to the log channel ─────────────────────────

  _forwardLog(entry) {
    if (!this.logChannelId || !this.client || !this.client.isReady()) return;
    const ch = this.client.channels.cache.get(this.logChannelId);
    if (!ch || !ch.isTextBased()) return;
    const ts = new Date(entry.at).toLocaleTimeString('en-GB', { hour12: false });
    ch.send('`' + ts + '` ' + entry.message).catch(() => {});
  }

  // ── Command handler ───────────────────────────────────────────────────────

  _handleMessage(message) {
    const raw = message.content.slice(PREFIX.length).trim();
    const parts = raw.split(/\s+/);
    const cmd = (parts[0] || 'help').toLowerCase();
    const args = parts.slice(1);
    const bm = this.botManager;

    const reply = (text) => message.reply(text).catch(() => {});
    const replyEmbed = (embed) => message.reply({ embeds: [embed] }).catch(() => {});

    switch (cmd) {

      // ── Help ──────────────────────────────────────────────────────────────
      case 'help': {
        const embed = new EmbedBuilder()
          .setColor(0x39FF14)
          .setTitle('FAERO Bot — Command Reference')
          .setDescription('Prefix: `' + PREFIX + ' <command>`')
          .addFields(
            { name: '`status`',          value: 'Full bot status report',           inline: true },
            { name: '`health`',          value: 'Health & hunger only',             inline: true },
            { name: '`resources`',       value: 'CPU/RAM usage report',             inline: true },
            { name: '`connect`',         value: 'Connect to Minecraft server',      inline: true },
            { name: '`disconnect`',      value: 'Disconnect bot',                   inline: true },
            { name: '`follow`',          value: 'Follow the authorized player',     inline: true },
            { name: '`stop`',            value: 'Stop current action',              inline: true },
            { name: '`go <x> <y> <z>`', value: 'Navigate to coordinates',          inline: true },
            { name: '`ai on|off`',       value: 'Toggle AI brain',                  inline: true },
            { name: '`logs [n]`',        value: 'Show last n log lines (max 10)',   inline: true }
          )
          .setFooter({ text: 'FAERO Minecraft AI • Personal use only' });
        return replyEmbed(embed);
      }

      // ── Status ────────────────────────────────────────────────────────────
      case 'status': {
        const s = bm.getStatus();
        const pos = s.position
          ? s.position.x + ', ' + s.position.y + ', ' + s.position.z
          : 'unknown';
        const embed = new EmbedBuilder()
          .setColor(s.running ? 0x39FF14 : 0xFF315F)
          .setTitle('Bot Status')
          .addFields(
            { name: '🟢 Online',    value: s.running ? 'Yes' : 'No',        inline: true },
            { name: '👤 Username',  value: s.username || '-',                inline: true },
            { name: '❤️ Health',    value: String(s.health ?? '-'),          inline: true },
            { name: '🍖 Hunger',    value: String(s.hunger ?? '-'),          inline: true },
            { name: '📍 Position',  value: pos,                              inline: true },
            { name: '⚡ State',     value: s.state ? s.state.state : 'idle', inline: true },
            { name: '🤖 AI Mode',   value: s.aiModeEnabled ? 'ON' : 'OFF',  inline: true },
            { name: '🔋 Low Power', value: s.lowPowerMode  ? 'ON' : 'OFF',  inline: true }
          )
          .setTimestamp();
        return replyEmbed(embed);
      }

      // ── Health ────────────────────────────────────────────────────────────
      case 'health': {
        const s = bm.getStatus();
        return reply(
          '❤️ Health: **' + (s.health ?? '-') + '** | 🍖 Hunger: **' + (s.hunger ?? '-') + '**'
        );
      }

      // ── Resource monitor ──────────────────────────────────────────────────
      case 'resources':
      case 'mem':
      case 'memory': {
        const stats = this._monitor
          ? this._monitor.getStats()
          : { heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
              rssMB:  Math.round(process.memoryUsage().rss        / 1024 / 1024),
              limitMB: Number(process.env.SAFE_HEAP_MB) || 400,
              uptimeMin: Math.round(process.uptime() / 60) };
        const pct = Math.round((stats.heapMB / stats.limitMB) * 100);
        const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
        const embed = new EmbedBuilder()
          .setColor(pct >= 90 ? 0xFF315F : pct >= 70 ? 0xFFAA00 : 0x39FF14)
          .setTitle('Resource Monitor')
          .addFields(
            { name: '💾 Heap Used', value: stats.heapMB + ' MB',                      inline: true },
            { name: '📊 Heap Limit', value: stats.limitMB + ' MB',                    inline: true },
            { name: '🧠 RSS',        value: stats.rssMB + ' MB',                       inline: true },
            { name: '⏱ Uptime',     value: stats.uptimeMin + ' min',                  inline: true },
            { name: '📈 Usage',      value: bar + ' ' + pct + '%',                    inline: false }
          )
          .setFooter({ text: 'Auto-disconnect triggers at ' + stats.limitMB + ' MB heap' })
          .setTimestamp();
        return replyEmbed(embed);
      }

      // ── Connect ───────────────────────────────────────────────────────────
      case 'connect': {
        bm.createBot()
          .then(() => reply('✅ Bot connecting to **' + (process.env.MC_HOST || 'localhost') + '**…'))
          .catch((err) => reply('❌ Connect failed: ' + err.message));
        return;
      }

      // ── Disconnect ────────────────────────────────────────────────────────
      case 'disconnect': {
        bm.stop();
        return reply('🔌 Bot disconnected.');
      }

      // ── Follow ────────────────────────────────────────────────────────────
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

      // ── Stop ──────────────────────────────────────────────────────────────
      case 'stop': {
        try {
          bm.runWebCommand('stop', {});
          reply('⛔ Bot stopped.');
        } catch (err) {
          reply('❌ ' + err.message);
        }
        return;
      }

      // ── Go to coords ──────────────────────────────────────────────────────
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

      // ── AI mode ───────────────────────────────────────────────────────────
      case 'ai': {
        const on = (args[0] || '').toLowerCase() === 'on';
        bm.setAiMode(on);
        return reply('🤖 AI mode: **' + (on ? 'ON' : 'OFF') + '**');
      }

      // ── Logs ──────────────────────────────────────────────────────────────
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
        return reply('❓ Unknown command. Type `' + PREFIX + ' help` for the command list.');
    }
  }
}

module.exports = DiscordBridge;
