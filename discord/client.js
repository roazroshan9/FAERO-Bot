/**
 * DiscordBridge — Discord bot integration for FAERO Minecraft Bot
 *
 * Prefix  : !bot <command>
 * Security: RBAC tier check before every command.
 *           Per-user rate limit (DISCORD_RATE_LIMIT_MS, default 3 s).
 * Compliance: No unauthorized network access. All actions map to legitimate
 *   mineflayer gameplay only. Personal, non-commercial use. See README.md.
 *
 * RBAC tiers (from config/roles.js)
 *   OWNER  — full access, role management, resource admin
 *   MOD    — help, status, health, logs
 *   NONE   — blocked with a clear denial message
 */

'use strict';

const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');
const roles = require('../config/roles');

const PREFIX = '!bot';
const DISCORD_RATE_LIMIT_MS = Number(process.env.DISCORD_RATE_LIMIT_MS) || 3000;

class DiscordBridge {
  constructor(botManager) {
    this.botManager = botManager;
    this.client     = null;
    this.logChannelId = process.env.DISCORD_LOG_CHANNEL_ID || null;
    this.guildId      = process.env.DISCORD_GUILD_ID       || null;
    this._logListener = null;
    this._userCooldowns = new Map();   // userId → last-command timestamp
    this._monitor       = null;        // set by app.js after construction
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
      console.log('[discord] DISCORD_TOKEN not set — Discord bridge disabled');
      return;
    }

    if (!roles.getConfig().ownerDiscordId) {
      console.warn(
        '[discord] WARNING: OWNER_DISCORD_ID is not set. ' +
        'All Discord commands are blocked until you add this secret. ' +
        'Get your ID from Discord → Settings → Advanced → Developer Mode, ' +
        'then right-click your username → Copy User ID.'
      );
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

      // ── Rate limit ─────────────────────────────────────────────────────
      const userId = message.author.id;
      const now    = Date.now();
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

  // ── Alert broadcast (used by resource monitor) ─────────────────────────────

  sendAlert(message) {
    if (!this.client || !this.client.isReady() || !this.logChannelId) return;
    const ch = this.client.channels.cache.get(this.logChannelId);
    if (!ch || !ch.isTextBased()) return;
    ch.send('⚠️ **FAERO ALERT:** ' + message).catch(() => {});
  }

  // ── Log forwarding ────────────────────────────────────────────────────────

  _forwardLog(entry) {
    if (!this.logChannelId || !this.client || !this.client.isReady()) return;
    const ch = this.client.channels.cache.get(this.logChannelId);
    if (!ch || !ch.isTextBased()) return;
    const ts = new Date(entry.at).toLocaleTimeString('en-GB', { hour12: false });
    ch.send('`' + ts + '` ' + entry.message).catch(() => {});
  }

  // ── RBAC middleware + dispatcher ──────────────────────────────────────────

  _handleMessage(message) {
    const raw   = message.content.slice(PREFIX.length).trim();
    const parts = raw.split(/\s+/);
    const cmd   = (parts[0] || 'help').toLowerCase();
    const args  = parts.slice(1);
    const bm    = this.botManager;
    const userId = message.author.id;

    const reply      = (text)  => message.reply(text).catch(() => {});
    const replyEmbed = (embed) => message.reply({ embeds: [embed] }).catch(() => {});

    // ── RBAC gate ──────────────────────────────────────────────────────────
    const userTier = roles.getDiscordTier(userId);

    if (!roles.canDiscord(userId, cmd)) {
      if (userTier === roles.TIERS.NONE) {
        const cfg = roles.getConfig();
        const hint = cfg.ownerDiscordId
          ? 'You are not in the FAERO role list. Ask the owner to add you.'
          : '`OWNER_DISCORD_ID` is not configured — RBAC is not active yet.';
        return reply('🚫 **Access Denied** — ' + hint);
      }
      return reply(
        '🔒 **Permission Denied** — `' + PREFIX + ' ' + cmd + '` requires **Owner** access.\n' +
        'Your role: **' + roles.tierName(userTier) + '**'
      );
    }

    // ── Commands ───────────────────────────────────────────────────────────

    switch (cmd) {

      // ── Help ───────────────────────────────────────────────────────────
      case 'help': {
        const isMod = userTier === roles.TIERS.MOD;
        const embed = new EmbedBuilder()
          .setColor(0x39FF14)
          .setTitle('FAERO Bot — Commands  [Role: ' + roles.tierName(userTier) + ']')
          .setDescription('Prefix: `' + PREFIX + ' <command>`')
          .addFields(
            { name: '`status`',    value: 'Full bot status',            inline: true },
            { name: '`health`',    value: 'HP & hunger',                inline: true },
            { name: '`logs [n]`',  value: 'Last n log lines (max 10)',  inline: true }
          );
        if (!isMod) {
          embed.addFields(
            { name: '`resources`',         value: 'RAM / uptime report',         inline: true },
            { name: '`connect`',           value: 'Connect to Minecraft',        inline: true },
            { name: '`disconnect`',        value: 'Disconnect bot',              inline: true },
            { name: '`follow`',            value: 'Follow authorized player',    inline: true },
            { name: '`stop`',              value: 'Stop current action',         inline: true },
            { name: '`go <x> <y> <z>`',   value: 'Navigate to coordinates',     inline: true },
            { name: '`ai on|off`',         value: 'Toggle AI brain',             inline: true },
            { name: '`roles`',             value: 'View RBAC config',            inline: true },
            { name: '`add-mod <id>`',      value: 'Add Discord moderator',       inline: true },
            { name: '`remove-mod <id>`',   value: 'Remove Discord moderator',    inline: true },
            { name: '`add-mcmod <name>`',  value: 'Add MC moderator',            inline: true },
            { name: '`remove-mcmod <n>`',  value: 'Remove MC moderator',         inline: true },
            { name: '`reload`',            value: 'Reload roles from file',      inline: true }
          );
        }
        embed.setFooter({ text: 'FAERO Minecraft AI • Personal use only' });
        return replyEmbed(embed);
      }

      // ── Status ─────────────────────────────────────────────────────────
      case 'status': {
        const s   = bm.getStatus();
        const pos = s.position ? s.position.x + ', ' + s.position.y + ', ' + s.position.z : 'unknown';
        const embed = new EmbedBuilder()
          .setColor(s.running ? 0x39FF14 : 0xFF315F)
          .setTitle('Bot Status')
          .addFields(
            { name: '🟢 Online',    value: s.running ? 'Yes' : 'No',        inline: true },
            { name: '👤 Username',  value: s.username || '-',                inline: true },
            { name: '❤️ Health',    value: String(s.health  ?? '-'),         inline: true },
            { name: '🍖 Hunger',    value: String(s.hunger  ?? '-'),         inline: true },
            { name: '📍 Position',  value: pos,                              inline: true },
            { name: '⚡ State',     value: s.state ? s.state.state : 'idle', inline: true },
            { name: '🤖 AI Mode',   value: s.aiModeEnabled ? 'ON' : 'OFF',  inline: true },
            { name: '🔋 Low Power', value: s.lowPowerMode  ? 'ON' : 'OFF',  inline: true }
          )
          .setTimestamp();
        return replyEmbed(embed);
      }

      // ── Health ─────────────────────────────────────────────────────────
      case 'health': {
        const s = bm.getStatus();
        return reply('❤️ Health: **' + (s.health ?? '-') + '** | 🍖 Hunger: **' + (s.hunger ?? '-') + '**');
      }

      // ── Logs ───────────────────────────────────────────────────────────
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

      // ── Resources ──────────────────────────────────────────────────────
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
            { name: '💾 Heap Used',  value: stats.heapMB + ' MB',   inline: true },
            { name: '📊 Heap Limit', value: stats.limitMB + ' MB',  inline: true },
            { name: '🧠 RSS',        value: stats.rssMB + ' MB',    inline: true },
            { name: '⏱ Uptime',     value: stats.uptimeMin + ' min', inline: true },
            { name: '📈 Usage',      value: bar + ' ' + pct + '%',  inline: false }
          )
          .setFooter({ text: 'Auto-disconnect triggers at ' + stats.limitMB + ' MB heap' })
          .setTimestamp();
        return replyEmbed(embed);
      }

      // ── Connect / Disconnect ────────────────────────────────────────────
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

      // ── Follow / Stop ───────────────────────────────────────────────────
      case 'follow': {
        if (!bm.bot) return reply('❌ Bot is offline.');
        try {
          bm.runWebCommand('follow', {});
          reply('👟 Following ' + (process.env.AUTHORIZED_USER || 'roaz') + '…');
        } catch (err) { reply('❌ ' + err.message); }
        return;
      }

      case 'stop': {
        try {
          bm.runWebCommand('stop', {});
          reply('⛔ Bot stopped.');
        } catch (err) { reply('❌ ' + err.message); }
        return;
      }

      // ── Go to coords ────────────────────────────────────────────────────
      case 'go': {
        const [x, y, z] = args.map(Number);
        if ([x, y, z].some((n) => !Number.isFinite(n))) {
          return reply('❌ Usage: `' + PREFIX + ' go <x> <y> <z>`');
        }
        try {
          bm.runWebCommand('go', { x, y, z });
          reply('🧭 Moving to **' + x + ', ' + y + ', ' + z + '**');
        } catch (err) { reply('❌ ' + err.message); }
        return;
      }

      // ── AI mode ─────────────────────────────────────────────────────────
      case 'ai': {
        const on = (args[0] || '').toLowerCase() === 'on';
        bm.setAiMode(on);
        return reply('🤖 AI mode: **' + (on ? 'ON' : 'OFF') + '**');
      }

      // ── RBAC: View roles ────────────────────────────────────────────────
      case 'roles': {
        const cfg = roles.getConfig();
        const embed = new EmbedBuilder()
          .setColor(0x39FF14)
          .setTitle('FAERO — RBAC Role Config')
          .addFields(
            { name: '👑 Owner Discord ID', value: cfg.ownerDiscordId || '*(not set — set OWNER_DISCORD_ID secret)*', inline: false },
            { name: '⚔️ Owner MC Name',    value: cfg.ownerMcName,                                                   inline: false },
            { name: '🛡 Mod Discord IDs',  value: cfg.modDiscordIds.join('\n') || '*(none)*',                        inline: false },
            { name: '🛡 Mod MC Names',     value: cfg.modMcNames.join(', ')   || '*(none)*',                        inline: false }
          )
          .setFooter({ text: 'Use add-mod / remove-mod to update. Changes apply instantly.' });
        return replyEmbed(embed);
      }

      // ── RBAC: Reload ────────────────────────────────────────────────────
      case 'reload': {
        roles.reloadRoles();
        bm.log('[rbac] Role config reloaded by ' + message.author.tag);
        return reply('✅ Role config reloaded from file. Changes are now active.');
      }

      // ── RBAC: Add Discord moderator ─────────────────────────────────────
      case 'add-mod': {
        const targetId = args[0] ? args[0].replace(/[<@!>]/g, '') : null;
        if (!targetId) return reply('❌ Usage: `' + PREFIX + ' add-mod <userId>` (or @mention)');
        const cfg = roles.getConfig();
        if (cfg.modDiscordIds.includes(targetId)) return reply('ℹ️ `' + targetId + '` is already a moderator.');
        roles.saveOverrides({ modDiscordIds: [...cfg.modDiscordIds, targetId] });
        bm.log('[rbac] Discord mod added: ' + targetId + ' by ' + message.author.tag);
        return reply('✅ Added Discord moderator: `' + targetId + '`\nThey now have access to: status, health, logs, help.');
      }

      // ── RBAC: Remove Discord moderator ──────────────────────────────────
      case 'remove-mod': {
        const targetId = args[0] ? args[0].replace(/[<@!>]/g, '') : null;
        if (!targetId) return reply('❌ Usage: `' + PREFIX + ' remove-mod <userId>` (or @mention)');
        const cfg = roles.getConfig();
        if (!cfg.modDiscordIds.includes(targetId)) return reply('ℹ️ `' + targetId + '` is not a moderator.');
        roles.saveOverrides({ modDiscordIds: cfg.modDiscordIds.filter(id => id !== targetId) });
        bm.log('[rbac] Discord mod removed: ' + targetId + ' by ' + message.author.tag);
        return reply('✅ Removed Discord moderator: `' + targetId + '`');
      }

      // ── RBAC: Add MC moderator ──────────────────────────────────────────
      case 'add-mcmod': {
        const name = args[0];
        if (!name) return reply('❌ Usage: `' + PREFIX + ' add-mcmod <MinecraftUsername>`');
        const cfg = roles.getConfig();
        if (cfg.modMcNames.includes(name)) return reply('ℹ️ `' + name + '` is already an MC moderator.');
        roles.saveOverrides({ modMcNames: [...cfg.modMcNames, name] });
        bm.log('[rbac] MC mod added: ' + name + ' by ' + message.author.tag);
        return reply('✅ Added MC moderator: `' + name + '`\nThey can now use: !help !status !follow !come in-game.');
      }

      // ── RBAC: Remove MC moderator ───────────────────────────────────────
      case 'remove-mcmod': {
        const name = args[0];
        if (!name) return reply('❌ Usage: `' + PREFIX + ' remove-mcmod <MinecraftUsername>`');
        const cfg = roles.getConfig();
        if (!cfg.modMcNames.includes(name)) return reply('ℹ️ `' + name + '` is not an MC moderator.');
        roles.saveOverrides({ modMcNames: cfg.modMcNames.filter(n => n !== name) });
        bm.log('[rbac] MC mod removed: ' + name + ' by ' + message.author.tag);
        return reply('✅ Removed MC moderator: `' + name + '`');
      }

      default:
        return reply('❓ Unknown command. Type `' + PREFIX + ' help` for the command list.');
    }
  }
}

module.exports = DiscordBridge;
