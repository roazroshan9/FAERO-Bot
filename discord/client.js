'use strict';

/**
 * DiscordBridge — Pro-level Discord bot integration for FAERO
 *
 * Prefix  : !bot <command>
 * Security: Strict RBAC tier check before every command.
 *           Per-user rate limit  (DISCORD_RATE_LIMIT_MS, default 3 s).
 *           Global rate limit    (DISCORD_GLOBAL_RATE_LIMIT, default 30 cmds / 60 s).
 *
 * RBAC tiers (from config/roles.js)
 *   OWNER   — full access, all role management
 *   ADMIN   — full functional access, can manage Managers only
 *   MANAGER — help, status, health, logs only
 *   NONE    — blocked with a clear denial message
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

    this._userCooldowns = new Map();
    this._globalBucket  = [];
    this._monitor       = null;
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
      const required = roles.DISCORD_PERMISSIONS[cmd] !== undefined
        ? roles.DISCORD_PERMISSIONS[cmd] : roles.TIERS.OWNER;
      return reply(
        '🔒 **Permission Denied** — `' + PREFIX + ' ' + cmd + '` requires **' +
        roles.tierName(required) + '** access.\n' +
        'Your role: **' + roles.tierName(userTier) + '**'
      );
    }

    // ── Commands ───────────────────────────────────────────────────────────

    switch (cmd) {

      // ── Help ───────────────────────────────────────────────────────────
      case 'help': {
        const isManager = userTier === roles.TIERS.MANAGER;
        const isAdmin   = userTier === roles.TIERS.ADMIN;
        const embed = new EmbedBuilder()
          .setColor(0x39FF14)
          .setTitle('FAERO Bot — Commands  [Role: ' + roles.tierName(userTier) + ']')
          .setDescription('Prefix: `' + PREFIX + ' <command>`')
          .addFields(
            { name: '`status`',   value: 'Full bot status',           inline: true },
            { name: '`health`',   value: 'HP & hunger',               inline: true },
            { name: '`logs [n]`', value: 'Last n log lines (max 10)', inline: true }
          );

        if (isAdmin || userTier === roles.TIERS.OWNER) {
          embed.addFields(
            { name: '`chat <message>`',   value: 'Relay message to Minecraft', inline: true },
            { name: '`follow`',           value: 'Follow authorized player',   inline: true },
            { name: '`stop`',             value: 'Stop current action',        inline: true },
            { name: '`go <x> <y> <z>`',  value: 'Navigate to coordinates',    inline: true },
            { name: '`add-manager <id>`',    value: 'Add Discord Manager',     inline: true },
            { name: '`remove-manager <id>`', value: 'Remove Discord Manager',  inline: true },
            { name: '`add-mcmanager <n>`',   value: 'Add MC Manager',          inline: true },
            { name: '`remove-mcmanager <n>`',value: 'Remove MC Manager',       inline: true }
          );
        }

        if (userTier === roles.TIERS.OWNER) {
          embed.addFields(
            { name: '`resources`',                    value: 'RAM / CPU / uptime report',   inline: true },
            { name: '`connect`',                      value: 'Connect to Minecraft',        inline: true },
            { name: '`disconnect`',                   value: 'Disconnect bot',              inline: true },
            { name: '`ai on|off`',                    value: 'Toggle AI brain',             inline: true },
            { name: '`plugins`',                      value: 'List all plugins & status',   inline: true },
            { name: '`plugin enable|disable <name>`', value: 'Toggle a plugin at runtime',  inline: true },
            { name: '`roles`',                        value: 'View RBAC config',            inline: true },
            { name: '`reload`',                       value: 'Reload roles from file',      inline: true },
            { name: '`add-admin <id>`',               value: 'Add Discord Admin',           inline: true },
            { name: '`remove-admin <id>`',            value: 'Remove Discord Admin',        inline: true },
            { name: '`add-mcadmin <name>`',           value: 'Add MC Admin',                inline: true },
            { name: '`remove-mcadmin <name>`',        value: 'Remove MC Admin',             inline: true }
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
          embed.addFields({ name: status + ' — `' + p.name + '` v' + p.version, value: p.description || '—', inline: false });
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
          if (!changed) return reply('ℹ️ Plugin `' + pluginName + '` is already ' + action + 'd.');
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
            { name: '👑 Owner Discord ID',    value: cfg.ownerDiscordId   || '*(not set — set OWNER_DISCORD_ID secret)*', inline: false },
            { name: '⚔️ Owner MC Name',       value: cfg.ownerMcName,                                                     inline: false },
            { name: '🛡 Admin Discord IDs',   value: cfg.adminDiscordIds.join('\n')   || '*(none)*',                       inline: false },
            { name: '🛡 Admin MC Names',      value: cfg.adminMcNames.join(', ')      || '*(none)*',                       inline: false },
            { name: '🔧 Manager Discord IDs', value: cfg.managerDiscordIds.join('\n') || '*(none)*',                       inline: false },
            { name: '🔧 Manager MC Names',    value: cfg.managerMcNames.join(', ')    || '*(none)*',                       inline: false }
          )
          .setFooter({ text: 'Use add-admin / add-manager commands to update. Changes apply instantly.' });
        return replyEmbed(embed);
      }

      // ── RBAC: Reload ────────────────────────────────────────────────────
      case 'reload': {
        roles.reloadRoles();
        bm.log('[rbac] Role config reloaded by ' + message.author.tag);
        return reply('✅ Role config reloaded from file. Changes are now active.');
      }

      // ── RBAC: Add Admin (Discord) — OWNER only ──────────────────────────
      case 'add-admin': {
        const targetId = args[0] ? args[0].replace(/[<@!>]/g, '') : null;
        if (!targetId) return reply('❌ Usage: `' + PREFIX + ' add-admin <userId>` (or @mention)');
        if (targetId === roles.getConfig().ownerDiscordId) {
          return reply('🚫 Cannot modify the Owner\'s role.');
        }
        const added = roles.addToRole('adminDiscordIds', targetId);
        if (!added) return reply('ℹ️ `' + targetId + '` is already an Admin.');
        // Remove from Manager list if present (promotion)
        roles.removeFromRole('managerDiscordIds', targetId);
        bm.log('[rbac] Discord Admin added: ' + targetId + ' by ' + message.author.tag);
        return reply('✅ Granted **Admin** role to `' + targetId + '`.\nThey now have full functional access and can manage Managers.');
      }

      // ── RBAC: Remove Admin (Discord) — OWNER only ───────────────────────
      case 'remove-admin': {
        const targetId = args[0] ? args[0].replace(/[<@!>]/g, '') : null;
        if (!targetId) return reply('❌ Usage: `' + PREFIX + ' remove-admin <userId>` (or @mention)');
        if (targetId === roles.getConfig().ownerDiscordId) {
          return reply('🚫 Cannot modify the Owner\'s role.');
        }
        const removed = roles.removeFromRole('adminDiscordIds', targetId);
        if (!removed) return reply('ℹ️ `' + targetId + '` is not an Admin.');
        bm.log('[rbac] Discord Admin removed: ' + targetId + ' by ' + message.author.tag);
        return reply('✅ Revoked **Admin** role from `' + targetId + '`. They now have no access.');
      }

      // ── RBAC: Add Admin (MC) — OWNER only ──────────────────────────────
      case 'add-mcadmin': {
        const name = args[0];
        if (!name) return reply('❌ Usage: `' + PREFIX + ' add-mcadmin <MinecraftUsername>`');
        const cfg = roles.getConfig();
        if (name === cfg.ownerMcName) return reply('🚫 Cannot modify the Owner\'s role.');
        const added = roles.addToRole('adminMcNames', name);
        if (!added) return reply('ℹ️ `' + name + '` is already an MC Admin.');
        roles.removeFromRole('managerMcNames', name);
        bm.log('[rbac] MC Admin added: ' + name + ' by ' + message.author.tag);
        return reply('✅ Granted **Admin** role to MC player `' + name + '`.\nThey have full functional access + can manage Managers in-game.');
      }

      // ── RBAC: Remove Admin (MC) — OWNER only ───────────────────────────
      case 'remove-mcadmin': {
        const name = args[0];
        if (!name) return reply('❌ Usage: `' + PREFIX + ' remove-mcadmin <MinecraftUsername>`');
        if (name === roles.getConfig().ownerMcName) return reply('🚫 Cannot modify the Owner\'s role.');
        const removed = roles.removeFromRole('adminMcNames', name);
        if (!removed) return reply('ℹ️ `' + name + '` is not an MC Admin.');
        bm.log('[rbac] MC Admin removed: ' + name + ' by ' + message.author.tag);
        return reply('✅ Revoked **Admin** role from MC player `' + name + '`. They now have no access.');
      }

      // ── RBAC: Add Manager (Discord) — ADMIN + OWNER ─────────────────────
      case 'add-manager': {
        const targetId = args[0] ? args[0].replace(/[<@!>]/g, '') : null;
        if (!targetId) return reply('❌ Usage: `' + PREFIX + ' add-manager <userId>` (or @mention)');
        const targetTier = roles.getDiscordTier(targetId);
        if (!roles.canModifyTier(userTier, targetTier)) {
          return reply('🚫 **Hierarchy violation** — you cannot modify `' + targetId + '` (their tier: **' + roles.tierName(targetTier) + '** ≥ yours: **' + roles.tierName(userTier) + '**).');
        }
        const added = roles.addToRole('managerDiscordIds', targetId);
        if (!added) return reply('ℹ️ `' + targetId + '` is already a Manager.');
        bm.log('[rbac] Discord Manager added: ' + targetId + ' by ' + message.author.tag);
        return reply('✅ Granted **Manager** role to `' + targetId + '`.\nThey now have access to: status, health, logs, help.');
      }

      // ── RBAC: Remove Manager (Discord) — ADMIN + OWNER ──────────────────
      case 'remove-manager': {
        const targetId = args[0] ? args[0].replace(/[<@!>]/g, '') : null;
        if (!targetId) return reply('❌ Usage: `' + PREFIX + ' remove-manager <userId>` (or @mention)');
        const targetTier = roles.getDiscordTier(targetId);
        if (!roles.canModifyTier(userTier, targetTier)) {
          return reply('🚫 **Hierarchy violation** — you cannot modify `' + targetId + '` (their tier: **' + roles.tierName(targetTier) + '** ≥ yours: **' + roles.tierName(userTier) + '**).');
        }
        const removed = roles.removeFromRole('managerDiscordIds', targetId);
        if (!removed) return reply('ℹ️ `' + targetId + '` is not a Manager.');
        bm.log('[rbac] Discord Manager removed: ' + targetId + ' by ' + message.author.tag);
        return reply('✅ Revoked **Manager** role from `' + targetId + '`.');
      }

      // ── RBAC: Add Manager (MC) — ADMIN + OWNER ──────────────────────────
      case 'add-mcmanager': {
        const name = args[0];
        if (!name) return reply('❌ Usage: `' + PREFIX + ' add-mcmanager <MinecraftUsername>`');
        const targetTier = roles.getMcTier(name);
        if (!roles.canModifyTier(userTier, targetTier)) {
          return reply('🚫 **Hierarchy violation** — you cannot modify `' + name + '` (their tier: **' + roles.tierName(targetTier) + '** ≥ yours: **' + roles.tierName(userTier) + '**).');
        }
        const added = roles.addToRole('managerMcNames', name);
        if (!added) return reply('ℹ️ `' + name + '` is already an MC Manager.');
        bm.log('[rbac] MC Manager added: ' + name + ' by ' + message.author.tag);
        return reply('✅ Granted **Manager** role to MC player `' + name + '`.\nThey can use: !help !status !follow !come !mine in-game.');
      }

      // ── RBAC: Remove Manager (MC) — ADMIN + OWNER ───────────────────────
      case 'remove-mcmanager': {
        const name = args[0];
        if (!name) return reply('❌ Usage: `' + PREFIX + ' remove-mcmanager <MinecraftUsername>`');
        const targetTier = roles.getMcTier(name);
        if (!roles.canModifyTier(userTier, targetTier)) {
          return reply('🚫 **Hierarchy violation** — you cannot modify `' + name + '` (their tier: **' + roles.tierName(targetTier) + '** ≥ yours: **' + roles.tierName(userTier) + '**).');
        }
        const removed = roles.removeFromRole('managerMcNames', name);
        if (!removed) return reply('ℹ️ `' + name + '` is not an MC Manager.');
        bm.log('[rbac] MC Manager removed: ' + name + ' by ' + message.author.tag);
        return reply('✅ Revoked **Manager** role from MC player `' + name + '`.');
      }

      // ── RBAC: Legacy aliases (map to manager for backward compat) ────────
      case 'add-mod': {
        const targetId = args[0] ? args[0].replace(/[<@!>]/g, '') : null;
        if (!targetId) return reply('❌ Usage: `' + PREFIX + ' add-mod <userId>`\n*(This is a legacy alias for `add-manager`)*');
        const added = roles.addToRole('managerDiscordIds', targetId);
        if (!added) return reply('ℹ️ `' + targetId + '` is already a Manager.');
        bm.log('[rbac] Discord Manager added (legacy add-mod): ' + targetId + ' by ' + message.author.tag);
        return reply('✅ Added Manager (legacy): `' + targetId + '`');
      }

      case 'remove-mod': {
        const targetId = args[0] ? args[0].replace(/[<@!>]/g, '') : null;
        if (!targetId) return reply('❌ Usage: `' + PREFIX + ' remove-mod <userId>`\n*(This is a legacy alias for `remove-manager`)*');
        const removed = roles.removeFromRole('managerDiscordIds', targetId);
        if (!removed) return reply('ℹ️ `' + targetId + '` is not a Manager.');
        bm.log('[rbac] Discord Manager removed (legacy remove-mod): ' + targetId + ' by ' + message.author.tag);
        return reply('✅ Removed Manager (legacy): `' + targetId + '`');
      }

      case 'add-mcmod': {
        const name = args[0];
        if (!name) return reply('❌ Usage: `' + PREFIX + ' add-mcmod <MinecraftUsername>`\n*(Legacy alias for `add-mcmanager`)*');
        const added = roles.addToRole('managerMcNames', name);
        if (!added) return reply('ℹ️ `' + name + '` is already an MC Manager.');
        bm.log('[rbac] MC Manager added (legacy add-mcmod): ' + name + ' by ' + message.author.tag);
        return reply('✅ Added MC Manager (legacy): `' + name + '`');
      }

      case 'remove-mcmod': {
        const name = args[0];
        if (!name) return reply('❌ Usage: `' + PREFIX + ' remove-mcmod <MinecraftUsername>`\n*(Legacy alias for `remove-mcmanager`)*');
        const removed = roles.removeFromRole('managerMcNames', name);
        if (!removed) return reply('ℹ️ `' + name + '` is not an MC Manager.');
        bm.log('[rbac] MC Manager removed (legacy remove-mcmod): ' + name + ' by ' + message.author.tag);
        return reply('✅ Removed MC Manager (legacy): `' + name + '`');
      }

      default:
        return reply('❓ Unknown command. Type `' + PREFIX + ' help` for the command list.');
    }
  }
}

module.exports = DiscordBridge;
