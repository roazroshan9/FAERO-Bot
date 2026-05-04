'use strict';
/**
 * FAERO — Discord Fleet Extension (modules/discordFleet.js)
 *
 * Extends DiscordBridge with !fleet commands and proactive fleet event alerts.
 * mountFleetExtension(bridge) is called from DiscordBridge.start() once the
 * Discord client is ready.
 *
 * Commands (prefix: !fleet, requires ADMIN tier):
 *   !fleet help
 *   !fleet status         — live-updating embed (same engine as !bot status)
 *   !fleet follow         — all minions follow the leader
 *   !fleet stop           — all minions stop
 *   !fleet come           — all minions navigate to leader now
 *   !fleet join           — reconnect offline / error minions
 *   !fleet leave          — disconnect all (keep registered)
 *   !fleet spawn <user>   — spawn a new minion bot
 *   !fleet dismiss <id>   — dismiss a minion by id
 *   !fleet build <name>   — distributed build across the fleet
 *
 * Proactive alerts → DISCORD_LOG_CHANNEL_ID:
 *   fleet:botKicked        — red embed with bot id + reason
 *   fleet:buildStart       — cyan embed with schematic + block count
 *   fleet:buildComplete    — green/amber embed with placed/failed stats
 */

const { EmbedBuilder } = require('discord.js');
const roles = require('../config/roles');

// ── Visual brand ──────────────────────────────────────────────────────────────
const C = {
  ONLINE:   0x00FFFF, // cyan
  OK:       0x39FF14, // neon green
  OFFLINE:  0x4A4A4A,
  ERROR:    0xFF315F,
  BUILD:    0x00FFFF,
  BUILD_OK: 0x39FF14,
  AMBER:    0xC9A227,
  KICK:     0xFF315F
};

const FLEET_PREFIX        = '!fleet';
const FLEET_MIN_TIER      = roles.TIERS ? roles.TIERS.ADMIN : 2;

// ── Status embed builder ───────────────────────────────────────────────────────

function buildFleetStatusEmbed(fleetManager, opts) {
  const stale = !!(opts && opts.stale);
  const data   = fleetManager.getStatus();
  const ldr    = data.leader;
  const mins   = data.minions;

  const leaderLine = ldr.online
    ? '`' + (ldr.username || '—') + '`' +
      '  ·  ' + String(ldr.state || 'idle').toUpperCase() +
      '  ·  HP ' + (ldr.health != null ? ldr.health.toFixed(0) : '—') + '/20' +
      (ldr.position ? '  ·  X' + ldr.position.x + ' Y' + ldr.position.y + ' Z' + ldr.position.z : '')
    : '`' + (ldr.username || 'Leader') + '` — **OFFLINE**';

  const totalOnline = mins.filter((m) =>
    m.state === 'online' || m.state === 'following' || m.state === 'busy'
  ).length;
  const following   = mins.filter((m) => m.following).length;

  const updatedTs  = Math.floor(Date.now() / 1000);
  const updatedFmt = stale
    ? '⏸ Panel stale — call `!fleet status` to resume'
    : 'Updated <t:' + updatedTs + ':T> · <t:' + updatedTs + ':R>';

  const embed = new EmbedBuilder()
    .setColor(stale ? C.OFFLINE : (totalOnline > 0 ? C.ONLINE : C.OFFLINE))
    .setTitle('◈ FAERO Fleet Control Panel')
    .setDescription('**Leader:** ' + leaderLine)
    .addFields(
      { name: '🤖 Minions',   value: '`' + mins.length + ' registered · ' + totalOnline + ' online`', inline: true },
      { name: '🔵 Following', value: '`' + following + '`',                                            inline: true },
      { name: '\u200b',       value: '\u200b',                                                         inline: true }
    );

  if (mins.length === 0) {
    embed.addFields({ name: '◎ Fleet', value: '`No minions spawned — use !fleet spawn <username>`', inline: false });
  } else {
    for (const m of mins) {
      const icon  = { online: '🟢', following: '🔵', connecting: '🟡', offline: '⚫', error: '🔴', busy: '🟣' }[m.state] || '⚫';
      const parts = [m.state.toUpperCase()];
      if (m.following)   parts.push('FOLLOW');
      if (m.health != null) parts.push('HP ' + m.health.toFixed(0));
      if (m.position)    parts.push('X' + m.position.x + ' Y' + m.position.y + ' Z' + m.position.z);
      parts.push(m.invCount + ' items');
      embed.addFields({
        name:   icon + ' ' + m.username + ' `[' + m.id + ']`',
        value:  '`' + parts.join('  ·  ') + '`',
        inline: false
      });
    }
  }

  embed
    .addFields({ name: '\u200b', value: updatedFmt, inline: false })
    .setFooter({ text: 'FAERO Fleet Manager  •  !fleet help for commands' });

  return embed;
}

// ── Proactive alert mounter ────────────────────────────────────────────────────
// Call once from DiscordBridge after the Discord client is ready.

function mountFleetExtension(bridge) {
  const fleetManager = require('../core/fleetManager');

  function sendAlert(embed) {
    if (!bridge.logChannelId || !bridge.client || !bridge.client.isReady()) return;
    const ch = bridge.client.channels.cache.get(bridge.logChannelId);
    if (!ch || !ch.isTextBased()) return;
    ch.send({ embeds: [embed] }).catch(() => {});
  }

  // Bot kicked
  fleetManager.on('fleet:botKicked', ({ id, username, reason }) => {
    sendAlert(new EmbedBuilder()
      .setColor(C.KICK)
      .setTitle('🚨 Fleet Bot Kicked — ' + (username || id))
      .addFields(
        { name: 'Bot ID',  value: '`' + id + '`',                          inline: true },
        { name: 'Reason',  value: String(reason || 'unknown').slice(0, 200), inline: false }
      )
      .setFooter({ text: 'FAERO Fleet Manager' })
      .setTimestamp()
    );
  });

  // Build started
  fleetManager.on('fleet:buildStart', ({ name, totalBlocks, bots }) => {
    sendAlert(new EmbedBuilder()
      .setColor(C.BUILD)
      .setTitle('🏗 Fleet Build Started — ' + name)
      .addFields(
        { name: 'Schematic',     value: '`' + name + '`',         inline: true },
        { name: 'Total Blocks',  value: '`' + totalBlocks + '`',  inline: true },
        { name: 'Bots Assigned', value: '`' + bots + '`',         inline: true }
      )
      .setFooter({ text: 'FAERO Fleet Manager  •  Build in progress…' })
      .setTimestamp()
    );
  });

  // Build complete
  fleetManager.on('fleet:buildComplete', ({ name, placed, failed, bots }) => {
    const ok = failed === 0;
    sendAlert(new EmbedBuilder()
      .setColor(ok ? C.BUILD_OK : C.AMBER)
      .setTitle((ok ? '✅' : '⚠️') + ' Fleet Build Complete — ' + name)
      .addFields(
        { name: 'Placed', value: '`' + placed + '`', inline: true },
        { name: 'Failed', value: '`' + failed + '`', inline: true },
        { name: 'Bots',   value: '`' + bots + '`',   inline: true }
      )
      .setFooter({ text: 'FAERO Fleet Manager' })
      .setTimestamp()
    );
  });

  bridge._fleetExtensionMounted = true;
}

// ── Fleet command handler ─────────────────────────────────────────────────────
// Called from DiscordBridge when a message starts with !fleet.

async function handleFleetCommand(bridge, message) {
  const fleetManager = require('../core/fleetManager');

  const reply      = (t) => message.reply(t).catch(() => {});
  const replyEmbed = (e) => message.reply({ embeds: [e] }).catch(() => {});
  const userId     = message.author.id;

  // RBAC gate
  const userTier = roles.getDiscordTier(userId);
  if (userTier < FLEET_MIN_TIER) {
    return reply(
      '🔒 **Permission Denied** — `!fleet` commands require **' +
      roles.tierName(FLEET_MIN_TIER) + '** access.\n' +
      'Your role: **' + roles.tierName(userTier) + '**'
    );
  }

  const raw  = message.content.slice(FLEET_PREFIX.length).trim();
  const parts = raw.split(/\s+/);
  const sub   = (parts[0] || 'status').toLowerCase();
  const args  = parts.slice(1);

  switch (sub) {

    // ── Help ──────────────────────────────────────────────────────────────────
    case 'help': {
      return replyEmbed(new EmbedBuilder()
        .setColor(C.ONLINE)
        .setTitle('◈ FAERO Fleet Commands')
        .setDescription('Prefix: `!fleet <command>`  ·  Requires **ADMIN** tier')
        .addFields(
          { name: '`status`',            value: 'Live fleet status embed (auto-refreshes)',   inline: false },
          { name: '`follow`',            value: 'All minions follow the leader',               inline: false },
          { name: '`stop`',              value: 'All minions stop moving',                     inline: false },
          { name: '`come`',              value: 'All minions navigate to leader position',     inline: false },
          { name: '`join`',              value: 'Reconnect all offline / error minions',       inline: false },
          { name: '`leave`',             value: 'Disconnect all (keep registered)',             inline: false },
          { name: '`spawn <username>`',  value: 'Spawn a new minion bot',                      inline: false },
          { name: '`dismiss <id>`',      value: 'Remove a minion by ID',                       inline: false },
          { name: '`build <schematic>`', value: 'Distribute a build across the fleet',         inline: false }
        )
        .setFooter({ text: 'FAERO Fleet Manager' })
      );
    }

    // ── Live status panel ─────────────────────────────────────────────────────
    case 'status': {
      return bridge._mountLivePanel(
        message, 'fleet',
        (opts) => buildFleetStatusEmbed(fleetManager, opts)
      );
    }

    // ── Group movement commands ───────────────────────────────────────────────
    case 'follow':
    case 'stop':
    case 'come':
    case 'join':
    case 'leave': {
      fleetManager.groupCommand(sub);
      const icons = { follow: '🔵', stop: '⛔', come: '📍', join: '🔌', leave: '🔌' };
      return reply((icons[sub] || '▸') + ' Fleet command `' + sub + '` dispatched to all minions.');
    }

    // ── Spawn ─────────────────────────────────────────────────────────────────
    case 'spawn': {
      const username = args[0];
      if (!username) return reply('❌ Usage: `!fleet spawn <username>`');
      try {
        const id = fleetManager.spawn({ username });
        return reply('✅ Spawned `' + username + '` as `' + id + '` — connecting to server…');
      } catch (err) {
        return reply('❌ Spawn failed: ' + err.message);
      }
    }

    // ── Dismiss ───────────────────────────────────────────────────────────────
    case 'dismiss': {
      const id = args[0];
      if (!id) return reply('❌ Usage: `!fleet dismiss <id>`  (e.g. `minion_1`)');
      try {
        fleetManager.dismiss(id);
        return reply('✅ Dismissed `' + id + '`.');
      } catch (err) {
        return reply('❌ ' + err.message);
      }
    }

    // ── Distributed build ─────────────────────────────────────────────────────
    case 'build': {
      const schematic = args[0];
      if (!schematic) {
        return reply(
          '❌ Usage: `!fleet build <schematic>`\n' +
          'Built-ins: `platform_5x5`, `tower_3x3`, `house_small`, `staircase_8`'
        );
      }
      const onlineBots = (() => {
        const s = fleetManager.getStatus();
        return s.minions.filter((m) =>
          m.state === 'online' || m.state === 'following'
        ).length + (s.leader.online ? 1 : 0);
      })();
      if (onlineBots === 0) return reply('❌ No online bots — connect the leader first.');

      message.reply({ embeds: [
        new EmbedBuilder()
          .setColor(C.BUILD)
          .setTitle('🏗 Fleet Build Queued — ' + schematic)
          .setDescription('Distributing across **' + onlineBots + '** online bot(s)…\nResults will be posted here when complete.')
          .setFooter({ text: 'FAERO Fleet Manager' })
      ] }).catch(() => {});

      fleetManager.distributeBuild(schematic)
        .then((result) => {
          const ok = result.failed === 0;
          message.channel.send({ embeds: [
            new EmbedBuilder()
              .setColor(ok ? C.BUILD_OK : C.AMBER)
              .setTitle((ok ? '✅' : '⚠️') + ' Build Complete — ' + result.name)
              .addFields(
                { name: 'Placed', value: '`' + result.placed + '`', inline: true },
                { name: 'Failed', value: '`' + result.failed + '`', inline: true },
                { name: 'Bots',   value: '`' + result.bots   + '`', inline: true }
              )
              .setFooter({ text: 'FAERO Fleet Manager' })
              .setTimestamp()
          ] }).catch(() => {});
        })
        .catch((err) => {
          message.channel.send('❌ Fleet build error: ' + err.message).catch(() => {});
        });
      return;
    }

    default:
      return reply('❓ Unknown fleet command `' + sub + '`. Type `!fleet help` for the command list.');
  }
}

module.exports = { mountFleetExtension, handleFleetCommand, buildFleetStatusEmbed };
