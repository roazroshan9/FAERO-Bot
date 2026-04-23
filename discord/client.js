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

    // ── Live control-panel registry ─────────────────────────────────────────
    // Keyed by `${channelId}:${panelType}` → { message, timer, expiresAt }
    // Ensures only ONE auto-updating embed per (channel, type) at any time.
    this._livePanels = new Map();
    this.LIVE_INTERVAL_MS = 5000;     // refresh cadence
    this.LIVE_LEASE_MS    = 30 * 60 * 1000; // auto-stop after 30 min idle
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
    this._teardownAllPanels();
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

  // ── EMERGENCY alert (red embed + owner mention) ───────────────────────────
  // Triggered by core/emergencyMonitor for low HP, combat, or disconnect.
  sendEmergencyAlert(payload) {
    if (!this.client || !this.client.isReady() || !this.logChannelId) return;
    const ch = this.client.channels.cache.get(this.logChannelId);
    if (!ch || !ch.isTextBased()) return;
    const ownerId = roles.getConfig().ownerDiscordId;
    const mention = ownerId ? '<@' + ownerId + '>' : '@here';
    const reason = String(payload && payload.reason || 'unknown').toUpperCase();
    const message = String(payload && payload.message || 'Critical event');
    const meta = payload && payload.meta || {};

    const embed = new EmbedBuilder()
      .setColor(0xFF1F1F)
      .setTitle('🚨 [ EMERGENCY ALERT ] — ' + reason)
      .setDescription('**' + message + '**')
      .addFields(
        { name: 'Bot Identity', value: '`' + (this.botManager.bot && this.botManager.bot.username || '—') + '`', inline: true },
        { name: 'Severity',     value: '`CRITICAL`', inline: true },
        { name: 'Trigger',      value: '`' + reason + '`', inline: true }
      );
    if (meta && Object.keys(meta).length > 0) {
      const lines = Object.entries(meta).slice(0, 6).map(([k, v]) => '• `' + k + '`: ' + String(v));
      embed.addFields({ name: 'Context', value: lines.join('\n').slice(0, 1024), inline: false });
    }
    embed.setFooter({ text: 'FAERO Emergency System • Connection Health Watchdog' })
      .setTimestamp(new Date());

    ch.send({ content: mention + ' ⚠️ Immediate attention required.', embeds: [embed], allowedMentions: { users: ownerId ? [ownerId] : [], parse: ownerId ? [] : ['everyone'] } }).catch(() => {});
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

      // ── Status (live-updating control panel) ───────────────────────────
      case 'status': {
        return this._mountLivePanel(message, 'status', () => this._buildStatusEmbed());
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

      // ── Resources (live-updating control panel) ────────────────────────
      case 'resources':
      case 'mem':
      case 'memory': {
        return this._mountLivePanel(message, 'resources', () => this._buildResourcesEmbed());
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

  // ════════════════════════════════════════════════════════════════════════
  //  LIVE CONTROL-PANEL ENGINE
  //  Sends ONE embed per (channel × type) and edits it every 5 s.
  //  Subsequent invocations renew the lease instead of spawning new posts.
  // ════════════════════════════════════════════════════════════════════════

  async _mountLivePanel(triggerMessage, type, builder) {
    const channelId = triggerMessage.channelId;
    const key       = channelId + ':' + type;
    const existing  = this._livePanels.get(key);
    const now       = Date.now();

    // ── Renew an existing live panel ────────────────────────────────────────
    if (existing && existing.message && !existing.message.deleted) {
      existing.expiresAt = now + this.LIVE_LEASE_MS;
      try {
        await existing.message.edit({ embeds: [builder()] });
        triggerMessage.reply({ content: '◈ Live panel refreshed — auto-update lease extended.', allowedMentions: { repliedUser: false } })
          .then((m) => setTimeout(() => m.delete().catch(() => {}), 4000))
          .catch(() => {});
      } catch (_) {
        // Message vanished — fall through and remount
        this._teardownPanel(key);
        return this._mountLivePanel(triggerMessage, type, builder);
      }
      return;
    }

    // ── Mount a fresh live panel ────────────────────────────────────────────
    let posted;
    try {
      posted = await triggerMessage.channel.send({ embeds: [builder()] });
    } catch (err) {
      try { triggerMessage.reply('Failed to send panel: ' + err.message); } catch (_) {}
      return;
    }

    const entry = {
      message:   posted,
      timer:     null,
      expiresAt: now + this.LIVE_LEASE_MS,
      type
    };
    this._livePanels.set(key, entry);

    entry.timer = setInterval(async () => {
      const cur = this._livePanels.get(key);
      if (!cur) return;
      if (Date.now() > cur.expiresAt) {
        // Final edit indicates the panel is now static
        try { await cur.message.edit({ embeds: [builder({ stale: true })] }); } catch (_) {}
        this._teardownPanel(key);
        return;
      }
      try {
        await cur.message.edit({ embeds: [builder()] });
      } catch (err) {
        // Permission revoked / message deleted / Discord error
        this.botManager.log('[discord] Live panel ' + type + ' edit failed: ' + (err && err.message ? err.message : err));
        this._teardownPanel(key);
      }
    }, this.LIVE_INTERVAL_MS);

    triggerMessage.reply({ content: '◈ Live ' + type.toUpperCase() + ' panel mounted — auto-refreshing every ' + Math.round(this.LIVE_INTERVAL_MS / 1000) + 's.', allowedMentions: { repliedUser: false } })
      .then((m) => setTimeout(() => m.delete().catch(() => {}), 4000))
      .catch(() => {});
  }

  _teardownPanel(key) {
    const entry = this._livePanels.get(key);
    if (!entry) return;
    if (entry.timer) clearInterval(entry.timer);
    this._livePanels.delete(key);
  }

  _teardownAllPanels() {
    for (const key of Array.from(this._livePanels.keys())) this._teardownPanel(key);
  }

  // ── Shared visual constants ─────────────────────────────────────────────
  static get COLORS() {
    return {
      PRIMARY:  0x008080, // dark cyan — enterprise control panel
      DEGRADED: 0xC9A227, // amber
      OFFLINE:  0x4A4A4A  // server gray
    };
  }

  _progressBar(percent, width) {
    const w = width || 18;
    const filled = Math.max(0, Math.min(w, Math.round((percent / 100) * w)));
    return '[' + '█'.repeat(filled) + '░'.repeat(w - filled) + '] ' + percent + '%';
  }

  _formatUptime(totalMin) {
    if (!totalMin || totalMin < 1) return '< 1m';
    const days  = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins  = Math.floor(totalMin % 60);
    const parts = [];
    if (days)  parts.push(days + 'd');
    if (hours) parts.push(hours + 'h');
    parts.push(mins + 'm');
    return parts.join(' ');
  }

  _systemHealth(s, ka, mem) {
    if (!s.running) return { code: 'OFFLINE',  symbol: '🔴', color: DiscordBridge.COLORS.OFFLINE };
    const lowHp     = typeof s.health === 'number' && s.health < 8;
    const lowFood   = typeof s.hunger === 'number' && s.hunger < 6;
    const memHigh   = mem && mem.limitMB && (mem.heapMB / mem.limitMB) > 0.8;
    const netStale  = ka && ka.attached && ka.msSinceLastPacket > 8000;
    const lagBurst  = ka && ka.lagWarnings > 0;
    if (lowHp || lowFood || memHigh || netStale || lagBurst) {
      return { code: 'DEGRADED', symbol: '🟡', color: DiscordBridge.COLORS.DEGRADED };
    }
    return { code: 'ONLINE', symbol: '🟢', color: DiscordBridge.COLORS.PRIMARY };
  }

  // ── Status panel ────────────────────────────────────────────────────────
  _buildStatusEmbed(opts) {
    const stale = !!(opts && opts.stale);
    const bm    = this.botManager;
    const s     = bm.getStatus();
    const ka    = bm.keepAlive ? bm.keepAlive.getStats() : null;
    const mem   = this._monitor ? this._monitor.getStats() : null;
    const ping  = (bm.bot && bm.bot.player && typeof bm.bot.player.ping === 'number') ? bm.bot.player.ping : null;
    const verdict = this._systemHealth(s, ka, mem);

    const pos = s.position
      ? '`X ' + s.position.x + '  Y ' + s.position.y + '  Z ' + s.position.z + '`'
      : '`unknown`';

    const queue = s.queue || { currentTask: null, pending: [] };
    const currentTask = queue.currentTask
      ? '`▶ ' + (queue.currentTask.name || queue.currentTask) + '`'
      : '`▷ idle`';
    const pendingCount = (queue.pending || []).length;

    // Survival background tasks (auto-eat / auto-craft / auto-sort)
    const survivalTasks = (bm._survivalTasks instanceof Set ? Array.from(bm._survivalTasks) : []);
    const survivalLine = survivalTasks.length
      ? '`' + survivalTasks.slice(0, 4).map(t => '◦ ' + t).join('  ') + '`'
      : '`◦ none active`';

    // Emergency severity from connection-health watchdog
    const sev = this._emergency ? this._emergency.getSeverity() : 'normal';
    const sevSym = sev === 'critical' ? '🔴' : sev === 'warning' ? '🟠' : '🟢';
    const healthLine = '`' + sevSym + ' ' + sev.toUpperCase() + '`';

    const stateName = s.state ? String(s.state.state || 'idle').toUpperCase() : 'IDLE';
    const stateLine = '`' + stateName + '`' + (s.state && s.state.reason ? ' · ' + s.state.reason : '');

    const networkLine = ka && ka.attached
      ? '`Ping ' + (ping !== null ? ping + 'ms' : '—') + '  ·  ' + ka.packetsPerSec + ' pkt/s`'
      : '`— offline —`';

    const vitalsLine = '`HP ' + (s.health ?? '—') + '/20  ·  Food ' + (s.hunger ?? '—') + '/20`';
    const modeLine   = '`AI ' + (s.aiModeEnabled ? 'ON' : 'OFF') + '  ·  LP ' + (s.lowPowerMode ? 'ON' : 'OFF') + '`';

    const updatedTs  = Math.floor(Date.now() / 1000);
    const updatedFmt = stale
      ? '⏸ Auto-update lease expired — call `' + PREFIX + ' status` to resume'
      : 'Last Updated: <t:' + updatedTs + ':T> · <t:' + updatedTs + ':R>';

    return new EmbedBuilder()
      .setColor(stale ? DiscordBridge.COLORS.OFFLINE : verdict.color)
      .setTitle('▣ FAERO Control Panel — System Status')
      .setDescription('**' + verdict.symbol + ' [' + verdict.code + ']**  ·  Identity: `' + (s.username || '—') + '`')
      .addFields(
        { name: '⚙ Operational State', value: stateLine, inline: true },
        { name: '◈ Mode Flags',         value: modeLine,  inline: true },
        { name: '\u200b',               value: '\u200b',  inline: true },

        { name: '⚓ Position',          value: pos,         inline: true },
        { name: '❤ Vitals',             value: vitalsLine,  inline: true },
        { name: '\u200b',               value: '\u200b',    inline: true },

        { name: '📡 Live Network',      value: networkLine, inline: true },
        { name: '⚙ Task Queue',         value: currentTask + '  ·  `' + pendingCount + ' queued`', inline: true },
        { name: '🛡 Conn. Health',      value: healthLine,  inline: true },

        { name: '🍞 Survival Tasks',    value: survivalLine, inline: false },

        { name: '\u200b', value: updatedFmt, inline: false }
      )
      .setFooter({ text: 'FAERO Engine v2.0 | Core System Monitor' });
  }

  // ── Resources panel ─────────────────────────────────────────────────────
  _buildResourcesEmbed(opts) {
    const stale = !!(opts && opts.stale);
    const bm    = this.botManager;
    const ka    = bm.keepAlive ? bm.keepAlive.getStats() : null;
    const ping  = (bm.bot && bm.bot.player && typeof bm.bot.player.ping === 'number') ? bm.bot.player.ping : null;
    const mem   = this._monitor
      ? this._monitor.getStats()
      : {
          heapMB:     Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          rssMB:      Math.round(process.memoryUsage().rss      / 1024 / 1024),
          limitMB:    Number(process.env.SAFE_HEAP_MB) || 400,
          cpuPercent: 0,
          uptimeMin:  Math.round(process.uptime() / 60)
        };
    const heapPct = Math.min(100, Math.round((mem.heapMB / Math.max(1, mem.limitMB)) * 100));
    const verdict = this._systemHealth(bm.getStatus(), ka, mem);

    const heapBar = '`' + this._progressBar(heapPct, 18) + '`';
    const cpuBar  = '`' + this._progressBar(mem.cpuPercent || 0, 18) + '`';

    const networkLine = ka && ka.attached
      ? '`Ping ' + (ping !== null ? ping + 'ms' : '—') + '  ·  ' + ka.packetsPerSec + ' pkt/s`'
      : '`— offline —`';

    const updatedTs  = Math.floor(Date.now() / 1000);
    const updatedFmt = stale
      ? '⏸ Auto-update lease expired — call `' + PREFIX + ' resources` to resume'
      : 'Last Updated: <t:' + updatedTs + ':T> · <t:' + updatedTs + ':R>';

    return new EmbedBuilder()
      .setColor(stale ? DiscordBridge.COLORS.OFFLINE : verdict.color)
      .setTitle('▣ FAERO Control Panel — Resource Monitor')
      .setDescription('**' + verdict.symbol + ' [' + verdict.code + ']**  ·  Process uptime: `' + this._formatUptime(mem.uptimeMin) + '`')
      .addFields(
        { name: '💾 Heap',    value: '`' + mem.heapMB + ' / ' + mem.limitMB + ' MB`', inline: true },
        { name: '🧠 RSS',     value: '`' + mem.rssMB + ' MB`',                         inline: true },
        { name: '\u200b',    value: '\u200b',                                         inline: true },

        { name: '⚙ CPU',      value: '`' + (mem.cpuPercent || 0) + ' %`', inline: true },
        { name: '📡 Network', value: networkLine,                          inline: true },
        { name: '\u200b',    value: '\u200b',                              inline: true },

        { name: '▮ Heap Usage', value: heapBar, inline: false },
        { name: '▮ CPU Load',   value: cpuBar,  inline: false },

        { name: '\u200b', value: updatedFmt, inline: false }
      )
      .setFooter({ text: 'FAERO Engine v2.0 | Core System Monitor · Heap ceiling ' + mem.limitMB + ' MB' });
  }
}

module.exports = DiscordBridge;
