/**
 * FAERO — In-Game Command Handler
 *
 * Entry point: handleChat(ctx, username, message)
 *   - Only responds to messages starting with !
 *   - RBAC tier checked before and per-command
 *   - Unauthorized users are silently ignored (no info disclosure)
 *   - All actions are rate-limited via commandCooldownMs
 *
 * TIER HIERARCHY
 *   MANAGER (1) — mine, move, follow, come, help, status
 *   ADMIN   (2) — everything Manager has + stop, protect, goto, attack, pay, balance
 *                 + can add/remove Managers (!addManager / !removeManager)
 *   OWNER   (3) — unrestricted + can add/remove Admins (!addAdmin / !removeAdmin)
 *
 * Personal, non-commercial use only. See README.md.
 */

'use strict';

const survival    = require('./survival');
const combat      = require('./combat');
const pathfinding = require('./pathfinding');
const economy     = require('./economy');
const { STATES }  = require('../core/stateManager');
const roles       = require('../config/roles');

// ─── Utilities ────────────────────────────────────────────────────────────────

function normalize(message) {
  return String(message || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function say(bot, message) {
  bot.chat('[FAERO]: ' + message);
}

function getInventoryCount(bot) {
  try { return bot.inventory ? bot.inventory.items().length : 0; } catch { return 0; }
}

function round1(n) { return Math.round(n * 10) / 10; }

function getTarget(bot, username) {
  const player = bot.players[username];
  if (!player || !player.entity) {
    say(bot, 'Error — Cannot locate you. Are you within render distance?');
    return null;
  }
  const dist = bot.entity.position.distanceTo(player.entity.position);
  if (dist > 50) {
    say(bot, 'Error — You are ' + Math.round(dist) + ' blocks away. Max range is 50.');
    return null;
  }
  return player.entity;
}

// ─── NLP Intent Parser ────────────────────────────────────────────────────────

function parseIntent(text) {
  if (/^(help|commands|what can you do|options|list commands?)$/.test(text)) return { cmd: 'help' };
  if (/^(status|stats|info|where are you|how are you|report|position|pos|location|health)$/.test(text)) return { cmd: 'status' };
  if (/^(follow(?: me)?|track me|stay close|trail me|accompany me)$/.test(text)) return { cmd: 'follow' };
  if (/^(come(?: here| to me| over)?|get to me|approach|come closer)$/.test(text)) return { cmd: 'come' };
  if (/^(stop|halt|freeze|cancel|abort|stand down|pause|idle|at ease)$/.test(text)) return { cmd: 'stop' };
  if (/^(protect(?: me)?|guardian(?: mode)?|guard(?: me)?|watch over me|defend(?: me)?)$/.test(text)) return { cmd: 'protect' };
  if (/^(jump|hop)$/.test(text)) return { cmd: 'jump' };
  if (/^(look around|look|survey|scan)$/.test(text)) return { cmd: 'look' };
  if (/^(eat(?: food)?|consume|feed yourself|eat something)$/.test(text)) return { cmd: 'eat' };
  if (/^(collect food|get food|food|gather food|forage|get something to eat)$/.test(text)) return { cmd: 'food' };
  if (/^(mine iron|dig iron|iron ore|get iron)$/.test(text)) return { cmd: 'mine_iron' };
  if (/^(cut wood|chop(?: wood)?|wood|lumber|get wood|tree)$/.test(text)) return { cmd: 'wood' };
  if (/^(bal|balance|money|wallet|cash|funds|how much)$/.test(text)) return { cmd: 'balance' };

  let m;

  // ── Role management ──────────────────────────────────────────────────────
  m = text.match(/^(?:add[\s_-]?admin)\s+([a-z0-9_]+)$/);
  if (m) return { cmd: 'add_admin', target: m[1] };

  m = text.match(/^(?:remove[\s_-]?admin|revoke[\s_-]?admin)\s+([a-z0-9_]+)$/);
  if (m) return { cmd: 'remove_admin', target: m[1] };

  m = text.match(/^(?:add[\s_-]?manager)\s+([a-z0-9_]+)$/);
  if (m) return { cmd: 'add_manager', target: m[1] };

  m = text.match(/^(?:remove[\s_-]?manager|revoke[\s_-]?manager)\s+([a-z0-9_]+)$/);
  if (m) return { cmd: 'remove_manager', target: m[1] };

  // ── Combat / movement / economy ──────────────────────────────────────────
  m = text.match(/^(?:attack|kill|fight|destroy|eliminate|target)\s+([a-z0-9_]+)$/);
  if (m) return { cmd: 'attack', target: m[1] };

  m = text.match(/^pay\s+([a-z0-9_]+)\s+(\d+)$/);
  if (m) return { cmd: 'pay', player: m[1], amount: Number(m[2]) };

  const coordsRe   = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/;
  const coordsMatch = text.match(coordsRe);
  if (coordsMatch && /^(?:go|goto|navigate|move|head|tp|teleport|path|route)/.test(text)) {
    return { cmd: 'goto', x: Number(coordsMatch[1]), y: Number(coordsMatch[2]), z: Number(coordsMatch[3]) };
  }

  m = text.match(/^(?:mine|dig)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)(?:\s+radius\s+(\d+))?$/);
  if (m) return { cmd: 'mine_area', x: Number(m[1]), y: Number(m[2]), z: Number(m[3]), radius: Number(m[4] || 5) };

  m = text.match(/^(?:mine|dig|find|get)\s+([a-z0-9_]+)(?:\s+(\d+))?$/);
  if (m) return { cmd: 'mine_block', block: m[1], amount: m[2] ? Math.max(1, Math.min(Number(m[2]), 256)) : 64 };

  return null;
}

// ─── Guardian Mode ────────────────────────────────────────────────────────────

function startGuardianMode(ctx, username, bot) {
  stopGuardianMode(ctx);
  ctx.manager._guardianActive   = true;
  ctx.manager._guardianUsername = username;

  ctx.manager._guardianTimer = setInterval(() => {
    if (!ctx.manager._guardianActive) return;
    if (!bot || !bot.entity) return;
    const player = bot.players[username];
    if (!player || !player.entity) return;

    const hostile = bot.nearestEntity((entity) => {
      if (!combat.isHostileMob(entity)) return false;
      return entity.position.distanceTo(player.entity.position) <= 10;
    });
    if (!hostile) return;

    try {
      if (bot.pvp && bot.pvp.attack) bot.pvp.attack(hostile);
      else bot.attack(hostile);
    } catch (_) {}
  }, 1500);
}

function stopGuardianMode(ctx) {
  if (ctx.manager && ctx.manager._guardianTimer) {
    clearInterval(ctx.manager._guardianTimer);
    ctx.manager._guardianTimer = null;
  }
  if (ctx.manager) {
    ctx.manager._guardianActive   = false;
    ctx.manager._guardianUsername = null;
  }
}

// ─── RBAC Gate (in-game) ──────────────────────────────────────────────────────

/**
 * handleChat — called from botManager on every in-game chat event.
 * Silently ignores non-! messages and unauthorized players.
 */
function handleChat(ctx, username, message) {
  if (username === ctx.bot.username) return false;

  const raw = String(message || '');
  if (!raw.startsWith('!')) return false;

  const tier = roles.getMcTier(username);

  // Silently ignore completely unknown users — no info disclosure to potential attackers
  if (tier === roles.TIERS.NONE) return false;

  const body = raw.slice(1).trim();
  return handleCommand(ctx, username, body, tier);
}

// ─── Command Dispatcher ───────────────────────────────────────────────────────

function handleCommand(ctx, username, message, tier) {
  const text = normalize(message);
  if (!text) return false;

  const bot = ctx.bot;
  if (!bot || !bot.entity) return false;

  const queue      = ctx.taskQueue;
  const state      = ctx.stateManager;
  const memory     = ctx.memory;
  const pvpEnabled = ctx.pvpEnabled;

  // Current tier (if called from web/Discord bridge, tier may be undefined)
  const userTier = tier !== undefined ? tier : roles.getMcTier(username);

  // ── Permission check helper ──────────────────────────────────────────────
  function permitCmd(cmd) {
    if (roles.canMinecraft(username, cmd)) return true;
    const required = roles.MC_PERMISSIONS[cmd] !== undefined
      ? roles.MC_PERMISSIONS[cmd] : roles.TIERS.OWNER;
    say(bot,
      'Permission denied — [' + cmd + '] requires **' + roles.tierName(required) + '** access.' +
      ' Your role: ' + roles.tierName(userTier)
    );
    return false;
  }

  // ── Branded task wrapper ─────────────────────────────────────────────────
  function commandTask(label, fn) {
    if (ctx.manager && ctx.manager.tryCommandCooldown) {
      if (!ctx.manager.tryCommandCooldown()) {
        say(bot, 'Cooldown active — wait a moment before the next command.');
        return false;
      }
    }
    if (ctx.manager && ctx.manager.commandInterrupt) ctx.manager.commandInterrupt();

    queue.clear();
    queue.push(label, async () => {
      state.setState(STATES.COMMAND, label);
      memory.setLastAction('command: ' + label);
      say(bot, 'Command [' + label + '] initialized.');
      try {
        await fn();
      } catch (err) {
        say(bot, 'Error — ' + classifyError(err));
      } finally {
        state.reset('command complete');
      }
    }, { priority: 100 });
    return true;
  }

  const intent = parseIntent(text);
  if (!intent) {
    say(bot, 'Unknown command. Type !help to see available commands.');
    return false;
  }

  // ── Per-intent RBAC check ────────────────────────────────────────────────
  if (!permitCmd(intent.cmd)) return false;

  switch (intent.cmd) {

    // ── Help ───────────────────────────────────────────────────────────────
    case 'help': {
      const isManager = userTier === roles.TIERS.MANAGER;
      const isAdmin   = userTier === roles.TIERS.ADMIN;
      bot.chat('[FAERO]: Role: ' + roles.tierName(userTier));
      bot.chat('[FAERO]: All roles: !help !status !follow !come !mine <block> [amount]');
      if (isAdmin || userTier === roles.TIERS.OWNER) {
        bot.chat('[FAERO]: Admin+: !stop !protect !go !mine !attack !eat !pay !bal !addManager <n> !removeManager <n>');
      }
      if (userTier === roles.TIERS.OWNER) {
        bot.chat('[FAERO]: Owner: !addAdmin <n> !removeAdmin <n>');
      }
      return true;
    }

    // ── Status ─────────────────────────────────────────────────────────────
    case 'status': {
      const pos = bot.entity.position;
      const x = round1(pos.x), y = round1(pos.y), z = round1(pos.z);
      const hp     = Math.round((bot.health || 0) * 10) / 10;
      const hunger = Math.round(bot.food || 0);
      const items  = getInventoryCount(bot);
      const guardianOn  = ctx.manager && ctx.manager._guardianActive;
      const stateLabel  = guardianOn ? 'GUARDIAN' : (state.getState ? state.getState().state : 'idle');
      say(bot,
        'Online | Pos: ' + x + ' ' + y + ' ' + z +
        ' | HP: ' + hp + '/20 | Hunger: ' + hunger + '/20' +
        ' | Items: ' + items + ' | Mode: ' + stateLabel
      );
      return true;
    }

    // ── Movement ───────────────────────────────────────────────────────────
    case 'follow':
      return commandTask('Follow', async () => {
        const target = getTarget(bot, username);
        if (!target) return;
        state.setState(STATES.FOLLOWING, username);
        pathfinding.followPlayer(bot, username, 2);
        say(bot, 'Tracking you at 2-block range.');
      });

    case 'come':
      return commandTask('Come', async () => {
        const target = getTarget(bot, username);
        if (!target) return;
        say(bot, 'Plotting route to your position.');
        await pathfinding.goToCoords(bot, target.position.x, target.position.y, target.position.z, 1);
        say(bot, 'Arrived.');
      });

    case 'stop':
      stopGuardianMode(ctx);
      return commandTask('Stop', async () => {
        pathfinding.stop(bot);
        combat.stopCombat(bot);
        say(bot, 'All tasks halted. Standing by.');
      });

    case 'goto':
      return commandTask('Goto', async () => {
        const { x, y, z } = intent;
        say(bot, 'Navigating to ' + x + ' ' + y + ' ' + z + ' — plotting safe route.');
        await pathfinding.goToCoords(bot, x, y, z, 1);
        say(bot, 'Destination reached: ' + x + ' ' + y + ' ' + z);
      });

    // ── Guardian Mode ──────────────────────────────────────────────────────
    case 'protect':
      return commandTask('Guardian', async () => {
        startGuardianMode(ctx, username, bot);
        say(bot, 'Guardian Mode ACTIVE — scanning 10-block radius around you for hostiles.');
      });

    // ── Jump / Look ────────────────────────────────────────────────────────
    case 'jump':
      return commandTask('Jump', async () => {
        bot.setControlState('jump', true);
        await new Promise((r) => setTimeout(r, 400));
        bot.setControlState('jump', false);
      });

    case 'look':
      return commandTask('Survey', async () => {
        bot.look(Math.random() * Math.PI * 2, 0, true);
        say(bot, 'Scanning surroundings.');
      });

    // ── Combat ─────────────────────────────────────────────────────────────
    case 'attack': {
      const tgt = intent.target;
      return commandTask('Attack', async () => {
        state.setState(STATES.FIGHTING, tgt);
        memory.addEnemy(tgt);
        await combat.attackPlayer(bot, memory, tgt, pvpEnabled);
      });
    }

    // ── Survival ───────────────────────────────────────────────────────────
    case 'food':
      return commandTask('Collect Food', async () => {
        say(bot, 'Scanning for nearby food sources.');
        await survival.collectFood(bot);
        say(bot, 'Food collection complete.');
      });

    case 'eat':
      return commandTask('Eat', async () => {
        if (getInventoryCount(bot) === 0) throw new Error('Inventory is empty — nothing to eat.');
        await survival.eatFood(bot);
        say(bot, 'Consumed food. HP: ' + Math.round(bot.health || 0));
      });

    // ── Mining ─────────────────────────────────────────────────────────────
    case 'mine_iron':
      return commandTask('Mine Iron', async () => {
        state.setState(STATES.MINING, 'iron');
        say(bot, 'Scanning for iron ore.');
        await survival.mineIron(bot);
        say(bot, 'Iron mining session complete.');
      });

    case 'wood':
      return commandTask('Cut Wood', async () => {
        state.setState(STATES.MINING, 'wood');
        say(bot, 'Locating trees.');
        await survival.cutWood(bot);
        say(bot, 'Wood collection complete.');
      });

    case 'mine_area': {
      const { x, y, z, radius } = intent;
      return commandTask('Area Mine', async () => {
        state.setState(STATES.MINING, 'area');
        say(bot, 'Area mining at ' + x + ' ' + y + ' ' + z + ' radius ' + radius);
        await survival.mineArea(bot, x, y, z, radius);
        say(bot, 'Area mine complete.');
      });
    }

    case 'mine_block': {
      const block  = intent.block;
      const amount = intent.amount;
      if (!bot.registry || !bot.registry.blocksByName[block]) {
        say(bot, 'Error — Unknown block "' + block + '". Check the name and try again.');
        return false;
      }
      return commandTask('Mine ' + block, async () => {
        state.setState(STATES.MINING, block);
        say(bot, 'Mining up to ' + amount + ' x ' + block + '. Searching within 32 blocks…');
        const result = await survival.mineBlockByName(bot, block, amount, (count) => {
          say(bot, 'Progress: ' + count + ' / ' + amount + ' ' + block + ' mined.');
        });
        const n = result.mined;
        if (result.reason === 'target_reached') {
          say(bot, 'Mining task complete: ' + n + ' x ' + block + ' collected.');
        } else if (result.reason === 'inventory_full') {
          say(bot, 'Inventory full — stopped at ' + n + ' x ' + block + ' collected.');
        } else if (result.reason === 'none_found') {
          say(bot, n > 0
            ? 'No more ' + block + ' nearby. Collected ' + n + ' x ' + block + '.'
            : 'Could not find any ' + block + ' within 32 blocks.');
        } else {
          say(bot, 'Mining stopped. Collected ' + n + ' x ' + block + '.');
        }
      });
    }

    // ── Economy ────────────────────────────────────────────────────────────
    case 'pay':
      return commandTask('Pay', async () => {
        state.setState(STATES.PAYING, intent.player);
        await economy.pay(bot, memory, intent.player, intent.amount, 'manual', 10000);
        say(bot, 'Payment of ' + intent.amount + ' to ' + intent.player + ' processed.');
      });

    case 'balance':
      return commandTask('Balance', async () => {
        economy.requestBalance(bot);
      });

    // ── Role Management ────────────────────────────────────────────────────

    case 'add_admin': {
      // OWNER-only (enforced by permitCmd)
      const targetName = intent.target;
      const cfg = roles.getConfig();
      if (targetName === cfg.ownerMcName) {
        say(bot, 'Cannot modify the Owner.');
        return false;
      }
      const targetTier = roles.getMcTier(targetName);
      if (targetTier === roles.TIERS.ADMIN) {
        say(bot, targetName + ' is already an Admin.');
        return false;
      }
      roles.addToRole('adminMcNames', targetName);
      // Remove from Manager if they were one (promotion)
      roles.removeFromRole('managerMcNames', targetName);
      say(bot, 'Granted Admin role to ' + targetName + '. Full functional access enabled.');
      return true;
    }

    case 'remove_admin': {
      // OWNER-only (enforced by permitCmd)
      const targetName = intent.target;
      const cfg = roles.getConfig();
      if (targetName === cfg.ownerMcName) {
        say(bot, 'Cannot modify the Owner.');
        return false;
      }
      const removed = roles.removeFromRole('adminMcNames', targetName);
      if (!removed) {
        say(bot, targetName + ' is not an Admin.');
        return false;
      }
      say(bot, 'Revoked Admin role from ' + targetName + '. Access removed.');
      return true;
    }

    case 'add_manager': {
      // ADMIN+ (enforced by permitCmd)
      // Hierarchy check: cannot modify anyone at own tier or above
      const targetName = intent.target;
      const targetTier = roles.getMcTier(targetName);
      if (!roles.canModifyTier(userTier, targetTier)) {
        say(bot,
          'Hierarchy violation — ' + targetName + ' has ' + roles.tierName(targetTier) +
          ' access (>= your ' + roles.tierName(userTier) + ' tier). Cannot modify.'
        );
        return false;
      }
      const added = roles.addToRole('managerMcNames', targetName);
      if (!added) {
        say(bot, targetName + ' is already a Manager.');
        return false;
      }
      say(bot, 'Granted Manager role to ' + targetName + '. Operational access enabled.');
      return true;
    }

    case 'remove_manager': {
      // ADMIN+ (enforced by permitCmd)
      const targetName = intent.target;
      const targetTier = roles.getMcTier(targetName);
      if (!roles.canModifyTier(userTier, targetTier)) {
        say(bot,
          'Hierarchy violation — ' + targetName + ' has ' + roles.tierName(targetTier) +
          ' access (>= your ' + roles.tierName(userTier) + ' tier). Cannot modify.'
        );
        return false;
      }
      const removed = roles.removeFromRole('managerMcNames', targetName);
      if (!removed) {
        say(bot, targetName + ' is not a Manager.');
        return false;
      }
      say(bot, 'Revoked Manager role from ' + targetName + '.');
      return true;
    }

    default:
      say(bot, 'Unknown command. Type !help to see available commands.');
      return false;
  }
}

// ─── Error Classifier ─────────────────────────────────────────────────────────

function classifyError(err) {
  const msg = (err && err.message) ? err.message.toLowerCase() : '';
  if (msg.includes('no path') || msg.includes('cannot find') || msg.includes('pathfind'))
    return 'Path blocked — cannot find a safe route to that location.';
  if (msg.includes('lava') || msg.includes('fire'))
    return 'Route blocked by lava or fire. Move to a safer area first.';
  if (msg.includes('inventory') || msg.includes('full'))
    return 'Inventory full — drop some items and try again.';
  if (msg.includes('too far') || msg.includes('distance'))
    return 'Target is too far away. Close the gap and retry.';
  if (msg.includes('not found') || msg.includes('no block') || msg.includes('no target'))
    return 'Target not found nearby. Try a different location or block type.';
  if (msg.includes('safety blocked') || msg.includes('pvp'))
    return 'Action blocked — PvP is disabled or target is not an enemy.';
  if (msg.includes('timeout'))
    return 'Action timed out — the task took too long and was aborted.';
  return (err && err.message) ? err.message : 'Unexpected error.';
}

module.exports = { handleChat, handleCommand, isAuthorized: () => false };
