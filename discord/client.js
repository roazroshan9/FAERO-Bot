'use strict';

/**
 * DiscordBridge — Pro-level Discord bot integration for FAERO
 *
 * Prefix  : !bot <command>
 * Security: RBAC tier check before every command.
 *           Per-user rate limit  (DISCORD_RATE_LIMIT_MS, default 3 s).
 *           Global rate limit    (DISCORD_GLOBAL_RATE_LIMIT, default 30 cmds / 60 s).
 *
 * Compliance: No unauthorized network access. All actions map to legitimate
 *   mineflayer gameplay only. Personal, non-commercial use. See README.md.
 *
 * RBAC tiers (from config/roles.js)
 *   OWNER  — full access, role management, resource admin, plugin control
 *   MOD    — help, status, health, logs
 *   NONE   — blocked with a clear denial message
 */

const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');
const roles = require('../config/roles');

const PREFIX = '!bot';

// ── Rate-limit configuration ──────────────────────────────────────────────────
const DISCORD_RATE_LIMIT_MS    = Number(process.env.DISCORD_RATE_LIMIT_MS)    || 3000;
const DISCORD_GLOBAL_MAX_CMDS  = Number(process.env.DISCORD_GLOBAL_MAX_CMDS)  || 30;
const DISCORD_GLOBAL_WINDOW_MS = Number(process.env.DISCORD_GLOBAL_WINDOW_MS) || 60000;

class DiscordBridge {
  constructor(botManager) {
    this.botManager   = botManager;
    this.client       = null;
    this.logChannelId = process.env.DISCORD_LOG_CHANNEL_ID || null;
    this.guildId      = process.env.DISCORD_GUILD_ID       || null;
    this._logListener = null;

    // Per-user cooldown map: userId → last-command timestamp
    this._userCooldowns = new Map();

    // Global sliding-window bucket: array of command timestamps
    this._globalBucket = [];

    // Monitor reference injected by app.js
    this._monitor = null;
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

      const userId = message.author.id;
      const now    = Date.now();

      // ── Per-user rate limit ─────────────────────────────────────────────
      const lastAt  = this._userCooldowns.get(userId) || 0;
      const elapsed = now - lastAt;
      if (elapsed < DISCORD_RATE_LIMIT_MS) {
        const waitSec = Math.ceil((DISCORD_RATE_LIMIT_MS - elapsed) / 1000);
        message.reply('⏳ Rate limit — wait **' + waitSec + 's** before your next command.').catch(() => {});
        return;
      }

      // ── Global rate limit (sliding window) ─────────────────────────────
      this._globalBucket = this._globalBucket.filter((t) => now - t < DISCORD_GLOBAL_WINDOW_MS);
      if (this._globalBucket.length >= DISCORD_GLOBAL_MAX_CMDS) {
        message.reply(
          '🚦 **Global rate limit reached** — max **' + DISCORD_GLOBAL_MAX_CMDS +
          '** commands per ' + Math.round(DISCORD_GLOBAL_WINDOW_MS / 1000) + 's. Please wait.'
        ).catch(() => {});
        return;
      }

      // Both limits passed — record the command
      this._userCooldowns.set(userId, now);
      this._globalBucket.push(now);

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
    const raw    = message.content.slice(PREFIX.length).trim();
    const parts  = raw.split(/\s+/);
    const cmd    = (parts[0] || 'help').toLowerCase();
    const args   = parts.slice(1);
    const bm     = this.botManager;
    const userId = message.author.id;

    const reply      = (text)  => message.reply(text).catch(() => {});
    const replyEmbed = (embed) => message.reply({ embeds: [embed] }).catch(() => {});

    // ── RBAC gate ──────────────────────────────────────────────────────────
    const userTier = roles.getDiscordTier(userId);

    if (!roles.canDiscord(userId, cmd)) {
      if (userTier === roles.TIERS.NONE) {
        const cfg  = roles.getConfig();
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
            { name: '`resources`',                     value: 'RAM / CPU / uptime report',    inline: true },
            { name: '`connect`',                       value: 'Connect to Minecraft',         inline: true },
            { name: '`disconnect`',                    value: 'Disconnect bot',               inline: true },
            { name: '`chat <message>`',                value: 'Relay message to Minecraft',   inline: true },
            { name: '`follow`',                        value: 'Follow authorized player',     inline: true },
            { name: '`stop`',                          value: 'Stop current action',          inline: true },
            { name: '`go <x> <y> <z>`',               value: 'Navigate to coordinates',      inline: true },
            { name: '`ai on|off`',                     value: 'Toggle AI brain',              inline: true },
            { name: '`plugins`',                       value: 'List all plugins & status',    inline: true },
            { name: '`plugin enable|disable <name>`',  value: 'Toggle a plugin at runtime',   inline: true },
            { name: '`roles`',                         value: 'View RBAC config',             inline: true },
            { name: '`add-mod <id>`',                  value: 'Add Discord moderator',        inline: true },
            { name: '`remove-mod <id>`',               value: 'Remove Discord moderator',     inline: true },
            { name: '`add-mcmod <name>`',              value: 'Add MC moderator',             inline: true },
            { name: '`remove-mcmod <n>`',              value: 'Remove MC moderator',          inline: true },
            { name: '`reload`',                        value: 'Reload roles from file',       inline: true }
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
          : {
              heapMB:     Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
              rssMB:      Math.round(process.memoryUsage().rss      / 1024 / 1024),
              limitMB:    Number(process.env.SAFE_HEAP_MB) || 400,
              cpuPercent: 0,
              uptimeMin:  Math.round(process.uptime() / 60)
            };
        const pct = Math.round((stats.heapMB / stats.limitMB) * 100);
        const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
        const embed = new EmbedBuilder()
          .setColor(pct >= 90 ? 0xFF315F : pct >= 70 ? 0xFFAA00 : 0x39FF14)
          .setTitle('Resource Monitor')
          .addFields(
            { name: '💾 Heap Used',  value: stats.heapMB + ' MB',     inline: true },
            { name: '📊 Heap Limit', value: stats.limitMB + ' MB',    inline: true },
            { name: '🧠 RSS',        value: stats.rssMB + ' MB',      inline: true },
            { name: '🖥️ CPU',        value: stats.cpuPercent + '%',   inline: true },
            { name: '⏱ Uptime',     value: stats.uptimeMin + ' min', inline: true },
            { name: '📈 Heap',       value: bar + ' ' + pct + '%',    inline: false }
          )
          .setFooter({ text: 'Auto-disconnect triggers at ' + stats.limitMB + ' MB heap' })
          .setTimestamp();
        return replyEmbed(embed);
      }

      // ── Chat relay ─────────────────────────────────────────────────────
      case 'chat': {
        if (!bm.bot) return reply('❌ Bot is offline — cannot relay message.');
        const text = args.join(' ').trim();
        if (!text) return reply('❌ Usage: `!bot chat <message>`');
        bm.bot.chat('[Discord] ' + message.author.username + ': ' + text);
        return reply('✅ Message relayed to Minecraft.');
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
        if (!bm.pluginLoader.isEnabled('navigation')) {
          return reply('❌ Navigation plugin is disabled. Enable it first with `!bot plugin enable navigation`.');
        }
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
        if (!bm.pluginLoader.isEnabled('navigation')) {
          return reply('❌ Navigation plugin is disabled. Enable it first with `!bot plugin enable navigation`.');
        }
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
        if (!bm.pluginLoader.isEnabled('ai')) {
          return reply('❌ AI plugin is disabled. Enable it first with `!bot plugin enable ai`.');
        }
        const on = (args[0] || '').toLowerCase() === 'on';
        bm.setAiMode(on);
        return reply('🤖 AI mode: **' + (on ? 'ON' : 'OFF') + '**');
      }

      // ── Plugin list ─────────────────────────────────────────────────────
      case 'plugins': {
        const list = bm.pluginLoader.list();
        if (!list.length) return reply('No plugins registered.');
        const embed = new EmbedBuilder()
          .setColor(0x39FF14)
          .setTitle('FAERO — Loaded Plugins')
          .setDescription('Use `!bot plugin enable/disable <name>` to toggle.');
        for (const p of list) {
          const status = p.enabled ? '🟢 Enabled' : '🔴 Disabled';
          embed.addFields({
            name:   status + ' — `' + p.name + '` v' + p.version,
            value:  p.description || '—',
            inline: false
          });
        }
        embed.setFooter({ text: 'FAERO Minecraft AI • Personal use only' });
        return replyEmbed(embed);
      }

      // ── Plugin enable / disable ─────────────────────────────────────────
      case 'plugin': {
        const action     = (args[0] || '').toLowerCase();
        const pluginName = (args[1] || '').toLowerCase();

        if (!['enable', 'disable'].includes(action) || !pluginName) {
          return reply('❌ Usage: `' + PREFIX + ' plugin enable|disable <name>`');
        }
        try {
          const changed = action === 'enable'
            ? bm.pluginLoader.enable(pluginName, bm)
            : bm.pluginLoader.disable(pluginName, bm);
          if (!changed) {
            return reply('ℹ️ Plugin `' + pluginName + '` is already ' + action + 'd.');
          }
          bm.log('[rbac] Plugin ' + action + 'd: ' + pluginName + ' by ' + message.author.tag);
          return reply('✅ Plugin `' + pluginName + '` ' + action + 'd successfully.');
        } catch (err) {
          return reply('❌ ' + err.message);
        }
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
