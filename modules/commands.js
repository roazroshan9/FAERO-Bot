/**
 * FAERO — In-Game Command Handler (v2)
 *
 * Entry point: handleChat(ctx, username, message)
 *   - Only responds to messages starting with !
 *   - RBAC tier checked before and per-command
 *   - Unauthorized users are silently ignored (no info disclosure)
 *   - All actions are rate-limited via commandCooldownMs
 *
 * TIER HIERARCHY
 *   MANAGER (1) — modes, inv, equip, pvp, target, retreat, sethome, home,
 *                 tp, wander, tasklist, debug, mineblock, follow, come, eat, food
 *   ADMIN   (2) — everything Manager has + stop, protect, goto, attack, pay,
 *                 balance, give, dropall, store, build, cleartasks, log, minearea
 *                 + can add/remove Managers
 *   OWNER   (3) — unrestricted + can add/remove Admins
 */

'use strict';

const survival      = require('./survival');
const combat        = require('./combat');
const combatAI      = require('./combatAI');
const pathfinding   = require('./pathfinding');
const economy       = require('./economy');
const inventory     = require('./inventory');
const inventoryMod  = inventory; // legacy alias (kept for backward-compat references)
const { STATES }    = require('../core/stateManager');
const roles         = require('../config/roles');
const models        = require('../lib/persistence/models');
const Vec3          = require('vec3').Vec3;
const { AreaScanner, SCAN_RANGE } = require('./scanner');
const securityLog                 = require('../core/securityLog');
const goalPlanner                 = require('../ai/goalPlanner');
const chatResponder               = require('../ai/chatResponder');
const autoBuild                   = require('./autoBuild');

// ─── Module-level scanner singleton (per-process; attached to ctx.manager) ────
// Using a module singleton ensures `!mineblock` and `!mode mine` share the same
// warmed-up cache without requiring manager construction changes.
let _scanner = null;
function getScanner() {
  if (!_scanner) _scanner = new AreaScanner();
  return _scanner;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function normalize(message) {
  return String(message || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function say(bot, message) {
  bot.chat('[FAERO]: ' + message);
}

function greet(tier) {
  if (tier === roles.TIERS.OWNER)   return 'Boss';
  if (tier === roles.TIERS.ADMIN)   return 'Admin';
  if (tier === roles.TIERS.MANAGER) return 'Commander';
  return 'User';
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

// ─── AI Mode System ───────────────────────────────────────────────────────────

const VALID_MODES = ['idle', 'survival', 'guard', 'farm', 'mine'];

function clearMode(ctx) {
  if (ctx.manager && ctx.manager._modeTimer) {
    clearInterval(ctx.manager._modeTimer);
    ctx.manager._modeTimer = null;
  }
  if (ctx.manager && ctx.manager._wanderSearchTimer) {
    clearInterval(ctx.manager._wanderSearchTimer);
    ctx.manager._wanderSearchTimer = null;
  }
  if (ctx.manager) ctx.manager._botMode = 'idle';
}

function setMode(ctx, mode, bot, username, state) {
  clearMode(ctx);
  // Stop scanner when switching away from mine/wander modes
  getScanner().stop();
  if (ctx.manager) ctx.manager._botMode = mode;

  switch (mode) {
    case 'idle':
      pathfinding.stop(bot);
      state.reset('mode: idle');
      break;

    case 'survival':
      ctx.manager._modeTimer = setInterval(async () => {
        if (!bot || !bot.entity) return;
        if ((bot.food || 0) < 14) {
          try {
            state.setState(STATES.COMMAND, 'auto-eat');
            await survival.eatFood(bot);
          } catch (_) {}
          finally { state.reset('survival mode'); }
        }
      }, 12000);
      break;

    case 'guard':
      state.setState(STATES.GUARDING, username);
      startGuardianMode(ctx, username, bot);
      break;

    case 'farm':
      state.setState(STATES.FARMING, 'auto-farm');
      ctx.manager._modeTimer = setInterval(async () => {
        if (!bot || !bot.entity) return;
        try { await survival.collectFood(bot); } catch (_) {}
      }, 35000);
      break;

    case 'mine':
      state.setState(STATES.MINING, 'auto-mine');
      // Start the area scanner so the block map is always warm
      getScanner().start(bot);
      ctx.manager._modeTimer = setInterval(async () => {
        if (!bot || !bot.entity) return;
        // ── Auto-craft a fresh pickaxe if the previous one broke ───────────
        try {
          const tasks = ctx.manager._survivalTasks;
          if (!survival.hasAnyPickaxe(bot)) {
            if (tasks) tasks.add('auto-craft pickaxe');
            const res = await survival.ensurePickaxe(bot);
            if (res.ok && res.reason === 'crafted') {
              say(bot, 'Crafted a fresh ' + res.tool + ' to keep mining.');
            }
            if (tasks) tasks.delete('auto-craft pickaxe');
          }
        } catch (_) {}
        // ── Auto-sort when inventory crosses 90% capacity ───────────────────
        try {
          if (inventory.isInventoryNearFull(bot)) {
            const tasks = ctx.manager._survivalTasks;
            if (tasks) tasks.add('auto-sort');
            const r = await inventory.sortInventory(bot);
            if (r.triggered && r.dropped > 0) {
              say(bot, 'Inventory at capacity — discarded ' + r.dropped + ' junk items.');
            }
            if (tasks) tasks.delete('auto-sort');
          }
        } catch (_) {}
        try { await survival.mineIron(bot); } catch (_) {}
      }, 65000);
      break;
  }
}

// ─── Guardian Mode ────────────────────────────────────────────────────────────

function startGuardianMode(ctx, username, bot) {
  stopGuardianMode(ctx);
  ctx.manager._guardianActive   = true;
  ctx.manager._guardianUsername = username;
  ctx.manager._guardianEngaging = false;

  ctx.manager._guardianTimer = setInterval(() => {
    if (!ctx.manager._guardianActive) return;
    if (!bot || !bot.entity) return;
    if (ctx.manager._guardianEngaging) return; // Don't overlap active fights

    const player = bot.players[username];
    if (!player || !player.entity) return;

    const hostile = bot.nearestEntity((entity) => {
      if (!combat.isHostileMob(entity)) return false;
      return entity.position.distanceTo(player.entity.position) <= 12;
    });
    if (!hostile) return;

    ctx.manager._guardianEngaging = true;
    combatAI.engageMob(bot, hostile, { retreatHealth: 8 })
      .then((result) => {
        if (!ctx.manager._guardianActive) return;
        if (result.result === 'killed') {
          const msg = 'Eliminated ' + hostile.name + (result.looted ? ' — drops collected.' : '.');
          say(bot, msg);
        } else if (result.result === 'retreated') {
          say(bot, 'Retreated from ' + hostile.name + ' — health too low.');
        }
      })
      .catch(() => {})
      .finally(() => { ctx.manager._guardianEngaging = false; });
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

// ─── Building Helpers ─────────────────────────────────────────────────────────

const BUILD_MATERIALS = [
  'cobblestone', 'stone', 'stone_bricks', 'oak_planks',
  'spruce_planks', 'birch_planks', 'sandstone', 'dirt'
];

function getBuildMaterial(bot, minCount) {
  for (const mat of BUILD_MATERIALS) {
    const type = bot.registry && bot.registry.itemsByName[mat];
    if (!type) continue;
    const stack = bot.inventory.items().find(i => i.type === type.id && i.count >= minCount);
    if (stack) return { item: stack, name: mat, id: type.id };
  }
  return null;
}

async function placeBlockAt(bot, x, y, z, buildItem) {
  const refBlock = bot.blockAt(new Vec3(x, y - 1, z));
  if (!refBlock || refBlock.name === 'air') return false;
  try {
    await bot.equip(buildItem, 'hand');
    await bot.lookAt(new Vec3(x + 0.5, y - 0.5, z + 0.5));
    await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
    await new Promise(r => setTimeout(r, 120));
    return true;
  } catch (_) {
    return false;
  }
}

async function buildWall(bot, state) {
  const needed = 10;
  const mat = getBuildMaterial(bot, needed);
  if (!mat) throw new Error('Need at least ' + needed + ' blocks of: ' + BUILD_MATERIALS.slice(0, 4).join(', '));

  state.setState(STATES.BUILDING, 'wall');
  const pos  = bot.entity.position.floored();
  const yaw  = bot.entity.yaw;
  // Perpendicular direction to the bot's facing = wall direction
  const wx = Math.round(Math.cos(yaw));
  const wz = Math.round(Math.sin(yaw));
  const fwdX = Math.round(-Math.sin(yaw));
  const fwdZ = Math.round(Math.cos(yaw));

  let placed = 0;
  for (let i = -2; i <= 2; i++) {
    for (let h = 0; h <= 1; h++) {
      const x = pos.x + wx * i + fwdX;
      const y = pos.y + h;
      const z = pos.z + wz * i + fwdZ;
      if (await placeBlockAt(bot, x, y, z, mat.item)) placed++;
    }
  }
  return { placed, mat: mat.name, type: 'wall' };
}

async function buildBridge(bot, state) {
  const needed = 8;
  const mat = getBuildMaterial(bot, needed);
  if (!mat) throw new Error('Need at least ' + needed + ' blocks of: ' + BUILD_MATERIALS.slice(0, 4).join(', '));

  state.setState(STATES.BUILDING, 'bridge');
  const pos  = bot.entity.position.floored();
  const yaw  = bot.entity.yaw;
  const fwdX = Math.round(-Math.sin(yaw));
  const fwdZ = Math.round(Math.cos(yaw));

  let placed = 0;
  for (let i = 1; i <= 8; i++) {
    const x = pos.x + fwdX * i;
    const y = pos.y - 1;
    const z = pos.z + fwdZ * i;
    const refBlock = bot.blockAt(new Vec3(x, y - 1, z));
    if (refBlock && refBlock.name !== 'air') {
      if (await placeBlockAt(bot, x, y, z, mat.item)) placed++;
    } else {
      // Place on the side of the last placed block
      try {
        const sideRef = bot.blockAt(new Vec3(x - fwdX, y, z - fwdZ));
        if (sideRef && sideRef.name !== 'air') {
          await bot.equip(mat.item, 'hand');
          await bot.placeBlock(sideRef, new Vec3(fwdX, 0, fwdZ));
          placed++;
          await new Promise(r => setTimeout(r, 120));
        }
      } catch (_) {}
    }
  }
  return { placed, mat: mat.name, type: 'bridge' };
}

async function buildHouse(bot, state) {
  const needed = 32;
  const mat = getBuildMaterial(bot, needed);
  if (!mat) throw new Error('Need at least ' + needed + ' blocks of: ' + BUILD_MATERIALS.slice(0, 4).join(', '));

  state.setState(STATES.BUILDING, 'house');
  const pos  = bot.entity.position.floored();
  const size = 3;
  let placed = 0;

  // Foundation ring (perimeter of size x size)
  for (let x = -size; x <= size; x++) {
    for (let z = -size; z <= size; z++) {
      if (Math.abs(x) === size || Math.abs(z) === size) {
        for (let h = 0; h <= 2; h++) {
          if (await placeBlockAt(bot, pos.x + x, pos.y + h, pos.z + z, mat.item)) placed++;
        }
      }
    }
  }
  return { placed, mat: mat.name, type: 'house' };
}

// ─── NLP Intent Parser ────────────────────────────────────────────────────────

function parseIntent(text) {
  // ── Simple keyword commands ───────────────────────────────────────────────
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
  if (/^(inv|inventory|items|what do you have|bag|backpack)$/.test(text)) return { cmd: 'inv' };
  if (/^(dropall|drop all|empty inventory|dump inventory|clear inventory)$/.test(text)) return { cmd: 'dropall' };
  if (/^(sort|sort inventory|cleanup|tidy|discard junk|toss junk)$/.test(text)) return { cmd: 'sort' };
  if (/^(store|store items|deposit|chest store|put away)$/.test(text)) return { cmd: 'store' };
  if (/^(retreat|flee|run away|escape|fall back|get away)$/.test(text)) return { cmd: 'retreat' };
  if (/^(sethome|set home|save home|mark home|home point)$/.test(text)) return { cmd: 'sethome' };
  if (/^(home|go home|return home|back to base|base)$/.test(text)) return { cmd: 'home' };

  // ── Waypoints (multi-location named storage) ─────────────────────────────
  m = text.match(/^waypoints?\s+(set|save|add)\s+([a-z0-9_-]{1,32})$/);
  if (m) return { cmd: 'waypoint', action: 'set', name: m[2] };
  m = text.match(/^waypoints?\s+(list|ls|show|all)$/);
  if (m) return { cmd: 'waypoint', action: 'list' };
  m = text.match(/^waypoints?\s+(tp|go|goto|teleport|navigate)\s+([a-z0-9_-]{1,32})$/);
  if (m) return { cmd: 'waypoint', action: 'tp', name: m[2] };
  m = text.match(/^waypoints?\s+(delete|del|remove|rm)\s+([a-z0-9_-]{1,32})$/);
  if (m) return { cmd: 'waypoint', action: 'delete', name: m[2] };

  if (/^(wander|roam|explore|drift|walk around|patrol)$/.test(text)) return { cmd: 'wander' };
  if (/^(tasklist|tasks|queue|task queue|what are you doing|current tasks)$/.test(text)) return { cmd: 'tasklist' };
  if (/^(cleartasks|clear tasks|cancel all|abort all|flush tasks)$/.test(text)) return { cmd: 'cleartasks' };

  let m;

  // ── AI Mode ───────────────────────────────────────────────────────────────
  m = text.match(/^mode\s+(idle|survival|guard|farm|mine)$/);
  if (m) return { cmd: 'mode', mode: m[1] };

  // ── PvP toggle ────────────────────────────────────────────────────────────
  m = text.match(/^pvp\s+(on|off|enable|disable|true|false|yes|no)$/);
  if (m) return { cmd: 'pvp_toggle', enabled: /^(on|enable|true|yes)$/.test(m[1]) };

  // ── Debug toggle ──────────────────────────────────────────────────────────
  m = text.match(/^debug\s+(on|off|enable|disable|true|false)$/);
  if (m) return { cmd: 'debug', enabled: /^(on|enable|true)$/.test(m[1]) };

  // ── Target mob ────────────────────────────────────────────────────────────
  m = text.match(/^(?:target|hunt|kill mob|fight)\s+([a-z0-9_]+)$/);
  if (m) return { cmd: 'target_mob', mob: m[1] };

  // ── Equip item ────────────────────────────────────────────────────────────
  m = text.match(/^(?:equip|hold|wield|use)\s+([a-z0-9_]+)$/);
  if (m) return { cmd: 'equip', item: m[1] };

  // ── TP to player ──────────────────────────────────────────────────────────
  m = text.match(/^(?:tp|teleport|goto player|go to)\s+([a-z0-9_]+)$/);
  if (m) return { cmd: 'tp', target: m[1] };

  // ── Log view ──────────────────────────────────────────────────────────────
  m = text.match(/^(?:log|logs|show logs?|recent logs?)(?:\s+(\d+))?$/);
  if (m) return { cmd: 'log_view', count: m[1] ? Math.min(Number(m[1]), 10) : 5 };

  // ── Build ─────────────────────────────────────────────────────────────────
  m = text.match(/^build\s+(house|wall|bridge)$/);
  if (m) return { cmd: 'build', structure: m[1] };

  m = text.match(/^build\s+schematic\s+([a-z0-9_-]+)$/);
  if (m) return { cmd: 'build_schematic', schematicName: m[1] };

  if (/^build\s+(stop|cancel)$/.test(text)) return { cmd: 'build_stop' };
  if (/^build\s+(status|progress)$/.test(text)) return { cmd: 'build_status' };
  if (/^build\s+(list|schematics?)$/.test(text)) return { cmd: 'build_list' };

  // ── Give ──────────────────────────────────────────────────────────────────
  m = text.match(/^give\s+([a-z0-9_]+)(?:\s+(\d+))?$/);
  if (m) return { cmd: 'give', item: m[1], amount: m[2] ? Math.max(1, Math.min(Number(m[2]), 2304)) : 1 };

  // ── Role management ───────────────────────────────────────────────────────
  m = text.match(/^(?:add[\s_-]?admin)\s+([a-z0-9_]+)$/);
  if (m) return { cmd: 'add_admin', target: m[1] };

  m = text.match(/^(?:remove[\s_-]?admin|revoke[\s_-]?admin)\s+([a-z0-9_]+)$/);
  if (m) return { cmd: 'remove_admin', target: m[1] };

  m = text.match(/^(?:add[\s_-]?manager)\s+([a-z0-9_]+)$/);
  if (m) return { cmd: 'add_manager', target: m[1] };

  m = text.match(/^(?:remove[\s_-]?manager|revoke[\s_-]?manager)\s+([a-z0-9_]+)$/);
  if (m) return { cmd: 'remove_manager', target: m[1] };

  // ── Combat / movement / economy ───────────────────────────────────────────
  m = text.match(/^(?:attack|kill|fight|destroy|eliminate|target)\s+([a-z0-9_]+)$/);
  if (m) return { cmd: 'attack', target: m[1] };

  m = text.match(/^pay\s+([a-z0-9_]+)\s+(\d+)$/);
  if (m) return { cmd: 'pay', player: m[1], amount: Number(m[2]) };

  const coordsRe    = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/;
  const coordsMatch = text.match(coordsRe);
  if (coordsMatch && /^(?:go|goto|navigate|move|head|tp|teleport|path|route)/.test(text)) {
    return { cmd: 'goto', x: Number(coordsMatch[1]), y: Number(coordsMatch[2]), z: Number(coordsMatch[3]) };
  }

  // ── Renamed: minearea (was mine_area) — 6-coord bounding box ─────────────
  m = text.match(/^minearea\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$/);
  if (m) {
    const cx = (Number(m[1]) + Number(m[4])) / 2;
    const cy = (Number(m[2]) + Number(m[5])) / 2;
    const cz = (Number(m[3]) + Number(m[6])) / 2;
    const radius = Math.max(
      Math.abs(Number(m[4]) - Number(m[1])),
      Math.abs(Number(m[6]) - Number(m[3]))
    ) / 2;
    return { cmd: 'minearea', x: cx, y: cy, z: cz, radius: Math.max(1, Math.ceil(radius)) };
  }
  // Legacy center+radius form
  m = text.match(/^minearea\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)(?:\s+radius\s+(\d+))?$/);
  if (m) return { cmd: 'minearea', x: Number(m[1]), y: Number(m[2]), z: Number(m[3]), radius: Number(m[4] || 5) };

  // ── Renamed: mineblock (was mine <block>) ─────────────────────────────────
  m = text.match(/^mineblock\s+([a-z0-9_]+)(?:\s+(\d+))?$/);
  if (m) return { cmd: 'mineblock', block: m[1], amount: m[2] ? Math.max(1, Math.min(Number(m[2]), 256)) : 64 };

  // ── Legacy: old !mine shorthand still works (falls through to mineblock) ──
  m = text.match(/^(?:mine|dig|find|get)\s+([a-z0-9_]+)(?:\s+(\d+))?$/);
  if (m) return { cmd: 'mineblock', block: m[1], amount: m[2] ? Math.max(1, Math.min(Number(m[2]), 256)) : 64 };

  // ── AI Brain — goal planner & natural chat ────────────────────────────────
  m = text.match(/^ai\s+(.+)$/);
  if (m) return { cmd: 'ai_goal', goal: m[1].trim() };

  m = text.match(/^(?:aistop|ai\s+stop|stopai|cleargoal|clear\s*goal)$/);
  if (m) return { cmd: 'ai_stop' };

  m = text.match(/^(?:aichat|ai\s*chat)\s+(on|off|enable|disable)$/i);
  if (m) return { cmd: 'ai_chat', enabled: /^(?:on|enable)$/i.test(m[1]) };

  return null;
}

// ─── RBAC Gate (in-game) ──────────────────────────────────────────────────────

const AFFIRMATIVES = new Set(['yes', 'yeah', 'yep', 'yup', 'y', 'sure', 'ok', 'okay', 'go', 'do it', 'please', 'please do', 'search']);
const NEGATIVES    = new Set(['no', 'nope', 'n', 'nah', 'cancel', 'stop', 'dont', "don't", 'forget it', 'never mind']);

function handleChat(ctx, username, message) {
  if (username === ctx.bot.username) return false;

  const tier = roles.getMcTier(username);
  // NONE-tier: log unauthorized !command attempts to security log
  if (tier === roles.TIERS.NONE) {
    const raw = String(message || '');
    if (raw.startsWith('!')) {
      securityLog.logUnauthorized(username, raw, 'mc');
    }
    return false;
  }

  const raw  = String(message || '');
  const norm = raw.trim().toLowerCase();
  const bot  = ctx.bot;

  // ── Pending wander-search confirmation check ─────────────────────────────
  // Fires when the bot previously asked "Should I start wandering to find X?"
  const pending = ctx.manager && ctx.manager._pendingWanderSearch;
  if (pending && pending.username === username && !raw.startsWith('!')) {
    const expired = Date.now() > pending.expires;
    if (expired) {
      ctx.manager._pendingWanderSearch = null;
    } else if (AFFIRMATIVES.has(norm)) {
      ctx.manager._pendingWanderSearch = null;
      _activateWanderSearch(ctx, username, pending.blockName, bot,
        ctx.stateManager, ctx.taskQueue);
      return true;
    } else if (NEGATIVES.has(norm)) {
      ctx.manager._pendingWanderSearch = null;
      say(bot, 'Understood. Staying put. Use !mineblock ' + pending.blockName + ' when ready.');
      return true;
    }
    // Not a yes/no → fall through to normal command handling
  }

  if (!raw.startsWith('!')) {
    // Natural AI chat — fires for MANAGER+ when AI chat is enabled.
    // Responds to ALL messages (not just name-mentions) so conversation feels natural.
    if (tier >= roles.TIERS.MANAGER && ctx.manager && ctx.manager.llmChatEnabled && raw.length >= 2) {
      const { think: _think } = require('../ai/decisionEngine');
      const _snap = bot && bot.entity ? _think(bot) : null;
      chatResponder.respond(ctx, username, raw, _snap).then(({ reply, plan }) => {
        if (reply) {
          say(bot, reply);
          // Forward to dashboard AI chat feed
          if (ctx.manager && typeof ctx.manager.emit === 'function') {
            ctx.manager.emit('ai_chat_reply', {
              username, message: raw, reply,
              at: new Date().toISOString()
            });
          }
        }
        if (plan && plan.length) {
          goalPlanner.executePlan(ctx, plan, raw, (msg) => say(bot, msg));
        }
      }).catch(err => {
        if (ctx.manager) ctx.manager.log('[chatAI] Error: ' + (err && err.message));
      });
    }
    return false;
  }

  const body = raw.slice(1).trim();
  return handleCommand(ctx, username, body, tier);
}

/** Switches to wander mode and keeps scanning, handing off to mining once found. */
function _activateWanderSearch(ctx, username, blockName, bot, state, queue) {
  const scanner = getScanner();
  say(bot, 'Starting wander-search for ' + blockName + '. I\'ll let you know when found!');
  setMode(ctx, 'wander', bot, username, state);
  // Also re-start scanner (setMode stopped it)
  scanner.start(bot);

  // Poll the scanner every 10 s while wandering
  const searchTimer = setInterval(async () => {
    const modeNow = ctx.manager && ctx.manager._botMode;
    if (modeNow !== 'wander') { clearInterval(searchTimer); return; }
    if (!bot || !bot.entity)  { clearInterval(searchTimer); return; }

    // Run a fresh immediate scan to capture new chunks
    await scanner.scanNow(bot).catch(() => {});

    if (scanner.hasBlock(blockName)) {
      clearInterval(searchTimer);
      const hit = scanner.getClosest(bot, blockName);
      say(bot, 'Found ' + blockName + ' while wandering!'
        + (hit ? ' At ' + round1(hit.x) + ' ' + round1(hit.y) + ' ' + round1(hit.z) + ' (' + hit.dist + ' blocks).' : '')
        + ' Switching to mining now.');
      setMode(ctx, 'mine', bot, username, state);
      queue.clear();
      queue.push('Mine ' + blockName, async () => {
        state.setState(STATES.MINING, blockName);
        const result = await survival.mineBlockByName(bot, blockName, 64, (count) => {
          say(bot, 'Progress: ' + count + '/64 ' + blockName + ' mined.');
        });
        say(bot, 'Done — collected ' + result.mined + ' x ' + blockName + '.');
        state.reset('wander-search mine complete');
      }, { priority: 100 });
    }
  }, 10000);

  // Store timer so it can be cancelled on mode-switch
  if (ctx.manager) ctx.manager._wanderSearchTimer = searchTimer;
}

// ─── Command Dispatcher ───────────────────────────────────────────────────────

function handleCommand(ctx, username, message, tier) {
  const text = normalize(message);
  if (!text) return false;

  const bot = ctx.bot;
  if (!bot || !bot.entity) return false;

  const queue  = ctx.taskQueue;
  const state  = ctx.stateManager;
  const memory = ctx.memory;
  const userTier = tier !== undefined ? tier : roles.getMcTier(username);

  // ── Permission check helper ──────────────────────────────────────────────
  function permitCmd(cmd) {
    if (roles.canMinecraft(username, cmd)) return true;
    const required = roles.MC_PERMISSIONS[cmd] !== undefined
      ? roles.MC_PERMISSIONS[cmd] : roles.TIERS.OWNER;
    // Log denial to security audit file
    securityLog.logDeny(
      username, cmd,
      roles.tierName(userTier),
      roles.tierName(required),
      'mc'
    );
    say(bot,
      'Permission denied — [' + cmd + '] requires ' + roles.tierName(required) +
      ' access. Your role: ' + roles.tierName(userTier)
    );
    return false;
  }

  // ── Branded task wrapper ─────────────────────────────────────────────────
  function commandTask(label, fn) {
    if (ctx.manager && ctx.manager.tryCommandCooldown) {
      if (!ctx.manager.tryCommandCooldown()) {
        say(bot, 'Cooldown active — wait a moment, ' + greet(userTier) + '.');
        return false;
      }
    }
    if (ctx.manager && ctx.manager.commandInterrupt) ctx.manager.commandInterrupt();
    say(bot, 'Command accepted, ' + greet(userTier) + '. Executing [' + label + ']…');

    queue.clear();
    queue.push(label, async () => {
      state.setState(STATES.COMMAND, label);
      memory.setLastAction('command: ' + label);
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

  if (!permitCmd(intent.cmd)) return false;

  switch (intent.cmd) {

    // ════════════════════════════════════════════════════════════════════════
    // HELP & STATUS
    // ════════════════════════════════════════════════════════════════════════

    case 'help': {
      const isAdmin = userTier >= roles.TIERS.ADMIN;
      const isOwner = userTier === roles.TIERS.OWNER;
      const mode = (ctx.manager && ctx.manager._botMode) || 'idle';
      bot.chat('[FAERO]: Role: ' + roles.tierName(userTier) + ' | Mode: ' + mode);
      bot.chat('[FAERO]: Movement: !follow !come !tp <player> !wander !sethome !home');
      bot.chat('[FAERO]: Mining:   !mineblock <block> [n] | !mine_iron | !wood');
      bot.chat('[FAERO]: Survival: !eat | !food | !inv | !equip <item> | !retreat | !sort');
      bot.chat('[FAERO]: Waypoints: !waypoint set|list|tp|delete <name>');
      bot.chat('[FAERO]: AI Modes: !mode idle|survival|guard|farm|mine');
      bot.chat('[FAERO]: AI Brain: !ai <goal> | !aistop | !aichat on|off');
      bot.chat('[FAERO]: Combat:   !pvp on|off | !target <mob> | !protect');
      bot.chat('[FAERO]: Debug:    !tasklist | !debug on|off | !status');
      if (isAdmin) {
        bot.chat('[FAERO]: Admin+:  !stop !goto !attack !pay !bal !give <item> [n]');
        bot.chat('[FAERO]: Admin+:  !dropall | !store | !minearea <x1 y1 z1 x2 y2 z2>');
        bot.chat('[FAERO]: Admin+:  !build wall|bridge|house | !cleartasks | !log [n]');
        bot.chat('[FAERO]: Admin+:  !addManager <n> | !removeManager <n>');
      }
      if (isOwner) {
        bot.chat('[FAERO]: Owner:   !addAdmin <n> | !removeAdmin <n>');
      }
      return true;
    }

    case 'status': {
      const pos  = bot.entity.position;
      const hp   = Math.round((bot.health || 0) * 10) / 10;
      const food = Math.round(bot.food || 0);
      const mode = (ctx.manager && ctx.manager._botMode) || 'idle';
      const snap = queue.snapshot();
      say(bot,
        'HP: ' + hp + '/20 | Food: ' + food + '/20 | Mode: ' + mode +
        ' | Pos: ' + round1(pos.x) + ' ' + round1(pos.y) + ' ' + round1(pos.z) +
        ' | Items: ' + getInventoryCount(bot) + ' | Task: ' + (snap.currentTask || 'none')
      );
      return true;
    }

    // ════════════════════════════════════════════════════════════════════════
    // AI MODES
    // ════════════════════════════════════════════════════════════════════════

    case 'mode': {
      const targetMode = intent.mode;
      if (!VALID_MODES.includes(targetMode)) {
        say(bot, 'Invalid mode. Choose: ' + VALID_MODES.join(', '));
        return false;
      }
      if (ctx.manager && ctx.manager.tryCommandCooldown) ctx.manager.tryCommandCooldown();
      if (targetMode !== 'guard') stopGuardianMode(ctx);
      setMode(ctx, targetMode, bot, username, state);
      say(bot, 'Mode switched to [' + targetMode.toUpperCase() + '], ' + greet(userTier) + '.');
      return true;
    }

    // ════════════════════════════════════════════════════════════════════════
    // MOVEMENT
    // ════════════════════════════════════════════════════════════════════════

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

    case 'stop': {
      // ── Top-priority STOP — bypass queue entirely ──────────────────────
      // Executes synchronously so it interrupts any running task immediately.
      // Order matters: stop scanner first (cheap), then movement, then queue.
      try { getScanner().stop(); } catch (_) {}
      clearMode(ctx);
      stopGuardianMode(ctx);
      try { pathfinding.stop(bot); } catch (_) {}
      try { combat.stopCombat(bot); } catch (_) {}
      try { queue.clear(); } catch (_) {}
      if (ctx.manager) {
        ctx.manager._pendingWanderSearch = null;
        if (ctx.manager.commandInterrupt) {
          try { ctx.manager.commandInterrupt(); } catch (_) {}
        }
      }
      state.reset('!stop command');
      say(bot, 'STOP — all tasks halted, scanner off, mode idle, queue cleared.');
      return true;
    }

    case 'goto':
      return commandTask('Goto', async () => {
        const { x, y, z } = intent;
        say(bot, 'Navigating to ' + x + ' ' + y + ' ' + z + '.');
        await pathfinding.goToCoords(bot, x, y, z, 1);
        say(bot, 'Arrived at ' + x + ' ' + y + ' ' + z + '.');
      });

    case 'tp': {
      const tpTarget = intent.target;
      return commandTask('TP to ' + tpTarget, async () => {
        const player = bot.players[tpTarget];
        if (!player || !player.entity) {
          say(bot, 'Cannot locate ' + tpTarget + ' — are they in range?');
          return;
        }
        const tPos = player.entity.position;
        say(bot, 'Heading to ' + tpTarget + ' at ' + round1(tPos.x) + ' ' + round1(tPos.y) + ' ' + round1(tPos.z) + '.');
        await pathfinding.goToCoords(bot, tPos.x, tPos.y, tPos.z, 2);
        say(bot, 'Reached ' + tpTarget + '.');
      });
    }

    case 'sethome': {
      const pos = bot.entity.position;
      const home = { x: pos.x, y: pos.y, z: pos.z };
      if (ctx.manager) ctx.manager._homePosition = home;
      // Persist to MongoDB if available; silently fall back to in-memory.
      models.upsertLocation({ owner: username, label: 'home', x: home.x, y: home.y, z: home.z })
        .then((ok) => {
          if (ok) say(bot, 'Home set at ' + round1(pos.x) + ' ' + round1(pos.y) + ' ' + round1(pos.z) + ' (saved to DB).');
          else    say(bot, 'Home set at ' + round1(pos.x) + ' ' + round1(pos.y) + ' ' + round1(pos.z) + ' (Local-Only Mode).');
        })
        .catch(() => say(bot, 'Home set at ' + round1(pos.x) + ' ' + round1(pos.y) + ' ' + round1(pos.z) + '.'));
      return true;
    }

    case 'home':
      return commandTask('Go Home', async () => {
        // Prefer persisted location; fall back to in-memory home.
        let home = await models.findLocation(username, 'home');
        if (!home && ctx.manager && ctx.manager._homePosition) {
          home = ctx.manager._homePosition;
        }
        if (!home) {
          say(bot, 'No home set — use !sethome first.');
          return;
        }
        say(bot, 'Heading home: ' + round1(home.x) + ' ' + round1(home.y) + ' ' + round1(home.z) + '.');
        await pathfinding.goToCoords(bot, home.x, home.y, home.z, 1);
        say(bot, 'Arrived home.');
      });

    case 'wander':
      return commandTask('Wander', async () => {
        state.setState(STATES.WANDERING, 'random patrol');
        // Keep scanner running while wandering — useful for wander-search
        const scanner = getScanner();
        if (!scanner.isActive()) scanner.start(bot);
        const origin = bot.entity.position.clone();
        say(bot, 'Wandering for 3 waypoints around current position. Scanner active.');
        for (let i = 0; i < 3; i++) {
          const wx = origin.x + (Math.random() - 0.5) * 40;
          const wz = origin.z + (Math.random() - 0.5) * 40;
          try {
            await pathfinding.goToCoords(bot, wx, origin.y, wz, 2);
          } catch (_) {}
          // Quick scan at each waypoint so map stays fresh
          await scanner.scanNow(bot).catch(() => {});
          await new Promise(r => setTimeout(r, 400));
        }
        say(bot, 'Wander complete. Scan map has ' + scanner.getSummary() + '.');
      });

    // ════════════════════════════════════════════════════════════════════════
    // GUARDIAN / COMBAT
    // ════════════════════════════════════════════════════════════════════════

    case 'protect':
      return commandTask('Guardian', async () => {
        startGuardianMode(ctx, username, bot);
        state.setState(STATES.GUARDING, username);
        say(bot, 'Guardian Mode ACTIVE — engaging threats within 12 blocks of you. Retreat threshold: ' + combatAI.RETREAT_HEALTH + ' HP.');
      });

    case 'attack': {
      const tgt = intent.target;
      return commandTask('Attack', async () => {
        state.setState(STATES.FIGHTING, tgt);
        memory.addEnemy(tgt);
        await combat.attackPlayer(bot, memory, tgt, ctx.manager ? ctx.manager.pvpEnabled : true);
      });
    }

    case 'pvp_toggle': {
      const newVal = intent.enabled;
      if (ctx.manager) ctx.manager.pvpEnabled = newVal;
      say(bot, 'PvP mode ' + (newVal ? 'ENABLED — hostile players now targetable.' : 'DISABLED — player attacks suppressed.'));
      return true;
    }

    case 'target_mob': {
      const mobName = intent.mob;
      return commandTask('Target ' + mobName, async () => {
        const mob = bot.nearestEntity(e =>
          e.name &&
          e.name.toLowerCase().includes(mobName.toLowerCase()) &&
          e.type === 'mob' &&
          bot.entity.position.distanceTo(e.position) <= combatAI.MAX_CHASE_DISTANCE
        );
        if (!mob) {
          say(bot, 'No ' + mobName + ' found within ' + combatAI.MAX_CHASE_DISTANCE + ' blocks.');
          return;
        }
        state.setState(STATES.FIGHTING, mob.name);
        const dist = Math.round(bot.entity.position.distanceTo(mob.position));
        say(bot, 'Engaging ' + mob.name + ' at ' + dist + ' blocks — retreat threshold: ' + combatAI.RETREAT_HEALTH + ' HP.');
        const result = await combatAI.engageMob(bot, mob, {});
        const summary = result.result === 'killed'
          ? 'Eliminated ' + mob.name + (result.looted ? ' — drops collected.' : '.')
          : result.result === 'retreated'
            ? 'Retreated from ' + mob.name + ' (health too low to re-engage).'
            : 'Lost track of ' + mob.name + '.';
        say(bot, summary);
      });
    }

    case 'retreat':
      return commandTask('Retreat', async () => {
        state.setState(STATES.ESCAPING, 'retreat');
        const hostile = bot.nearestEntity(e => combat.isHostileMob(e));
        if (!hostile) {
          say(bot, 'No immediate threat detected — standing by.');
          state.reset('no threat');
          return;
        }
        const myPos     = bot.entity.position;
        const threatPos = hostile.position;
        const dx = myPos.x - threatPos.x;
        const dz = myPos.z - threatPos.z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        const rx  = myPos.x + (dx / len) * 20;
        const rz  = myPos.z + (dz / len) * 20;
        say(bot, 'Retreating from ' + hostile.name + ' — moving 20 blocks away!');
        await pathfinding.goToCoords(bot, rx, myPos.y, rz, 2);
        say(bot, 'Retreat complete. Distance from threat: ' + Math.round(bot.entity.position.distanceTo(threatPos)) + ' blocks.');
      });

    // ════════════════════════════════════════════════════════════════════════
    // INVENTORY
    // ════════════════════════════════════════════════════════════════════════

    case 'inv': {
      const items = bot.inventory.items();
      if (items.length === 0) {
        say(bot, 'Inventory is empty.');
        return true;
      }
      const counts = {};
      items.forEach(item => { counts[item.displayName] = (counts[item.displayName] || 0) + item.count; });
      const total = items.reduce((s, i) => s + i.count, 0);
      const lines = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => count + 'x ' + name)
        .join(', ');
      say(bot, 'Inventory (' + total + ' items, ' + items.length + ' types): ' + lines);
      return true;
    }

    case 'equip': {
      return commandTask('Equip ' + intent.item, async () => {
        const registry = bot.registry;
        const itemType = registry && (registry.itemsByName[intent.item] || registry.blocksByName[intent.item]);
        if (!itemType) {
          say(bot, 'Unknown item "' + intent.item + '". Use the internal name (e.g. diamond_sword).');
          return;
        }
        const stack = bot.inventory.items().find(i => i.type === itemType.id);
        if (!stack) {
          say(bot, "I don't have " + intent.item + ' in my inventory.');
          return;
        }
        await bot.equip(stack, 'hand');
        say(bot, 'Equipped ' + stack.displayName + ' to main hand.');
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // WAYPOINTS — named, persistent locations (MongoDB-backed)
    // ════════════════════════════════════════════════════════════════════════
    case 'waypoint': {
      const action = intent.action;
      const name   = intent.name;
      const owner  = roles.getConfig().ownerMcName || username;

      if (action === 'set') {
        const pos = bot.entity.position;
        models.upsertLocation({ owner, label: name, x: pos.x, y: pos.y, z: pos.z })
          .then((ok) => {
            if (ok) say(bot, 'Waypoint [' + name + '] saved at ' + round1(pos.x) + ' ' + round1(pos.y) + ' ' + round1(pos.z) + '.');
            else    say(bot, 'Error — waypoint [' + name + '] not saved (persistence offline).');
          })
          .catch((err) => say(bot, 'Error — waypoint save failed: ' + (err && err.message ? err.message : 'unknown')));
        return true;
      }

      if (action === 'list') {
        models.listLocations(owner)
          .then((all) => {
            if (!all.length) {
              say(bot, 'No waypoints saved. Use !waypoint set <name> to create one.');
              return;
            }
            const summary = all.slice(0, 10).map(w =>
              w.label + ' (' + Math.round(w.x) + ',' + Math.round(w.y) + ',' + Math.round(w.z) + ')'
            ).join(' | ');
            say(bot, 'Waypoints (' + all.length + '): ' + summary);
          })
          .catch(() => say(bot, 'Error — could not load waypoints (persistence offline).'));
        return true;
      }

      if (action === 'tp') {
        return commandTask('Waypoint TP ' + name, async () => {
          const wp = await models.findLocation(owner, name);
          if (!wp) {
            say(bot, 'Error — waypoint [' + name + '] not found. Use !waypoint list to see saved points.');
            return;
          }
          say(bot, 'Navigating to waypoint [' + name + '] at ' + round1(wp.x) + ' ' + round1(wp.y) + ' ' + round1(wp.z) + '.');
          await pathfinding.goToCoords(bot, wp.x, wp.y, wp.z, 1);
          say(bot, 'Arrived at waypoint [' + name + '].');
        });
      }

      if (action === 'delete') {
        models.deleteLocation(owner, name)
          .then((r) => {
            if (r.ok) say(bot, 'Waypoint [' + name + '] deleted.');
            else if (r.reason === 'offline') say(bot, 'Error — cannot delete waypoint (persistence offline).');
            else say(bot, 'Error — waypoint [' + name + '] not found.');
          })
          .catch((err) => say(bot, 'Error — delete failed: ' + (err && err.message ? err.message : 'unknown')));
        return true;
      }
      return false;
    }

    case 'sort':
      return commandTask('Sort Inventory', async () => {
        const before = bot.inventory.items().length;
        const r = await inventory.sortInventory(bot, { force: true });
        if (r.dropped === 0) {
          say(bot, 'Nothing to sort — no junk items detected (' + before + '/' + inventory.MAIN_INVENTORY_SLOTS + ' slots).');
        } else {
          say(bot, 'Sorted: discarded ' + r.dropped + ' junk items. Now at ' + r.kept + '/' + inventory.MAIN_INVENTORY_SLOTS + ' slots (' + r.capacityPct + '%).');
        }
      });

    case 'dropall':
      return commandTask('Drop All', async () => {
        const items = bot.inventory.items();
        if (items.length === 0) { say(bot, 'Inventory already empty.'); return; }
        let dropped = 0;
        for (const item of items) {
          try { await bot.tossStack(item); dropped++; } catch (_) {}
        }
        say(bot, 'Dropped ' + dropped + ' stack(s) — inventory cleared.');
      });

    case 'store':
      return commandTask('Store Items', async () => {
        state.setState(STATES.STORING, 'chest');
        const chestBlock = bot.registry && bot.registry.blocksByName['chest'];
        if (!chestBlock) { say(bot, 'Cannot locate chest block in registry.'); return; }
        const chest = bot.findBlock({ matching: chestBlock.id, maxDistance: 16 });
        if (!chest) { say(bot, 'No chest found within 16 blocks.'); return; }
        say(bot, 'Moving to chest at ' + chest.position.x + ' ' + chest.position.y + ' ' + chest.position.z + '.');
        await pathfinding.goToCoords(bot, chest.position.x, chest.position.y, chest.position.z, 2);
        const chestWindow = await bot.openChest(chest);
        const invItems = bot.inventory.items();
        let stored = 0;
        for (const item of invItems) {
          try {
            await chestWindow.deposit(item.type, null, item.count);
            stored += item.count;
          } catch (_) {}
        }
        chestWindow.close();
        say(bot, 'Stored ' + stored + ' items in chest.');
      });

    case 'give': {
      return commandTask('Give ' + intent.item, async () => {
        const registry = bot.registry;
        const itemType = registry && (registry.itemsByName[intent.item] || registry.blocksByName[intent.item]);
        if (!itemType) {
          say(bot, 'Unknown item "' + intent.item + '". Use the internal name (e.g. iron_ingot).');
          return;
        }
        const matchingStacks = bot.inventory.items().filter(i => i.type === itemType.id);
        const totalAvailable  = matchingStacks.reduce((sum, i) => sum + i.count, 0);
        if (totalAvailable === 0) {
          say(bot, "I don't have any " + intent.item + ' in my inventory.');
          return;
        }
        if (totalAvailable < intent.amount) {
          say(bot, "I don't have enough of that item. Have " + totalAvailable + ' x ' + intent.item + ', need ' + intent.amount + '.');
          return;
        }
        await bot.toss(itemType.id, null, intent.amount);
        say(bot, 'Dropped ' + intent.amount + ' x ' + intent.item + ' for you.');
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // SURVIVAL / MINING
    // ════════════════════════════════════════════════════════════════════════

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

    case 'minearea': {
      const { x, y, z, radius } = intent;
      return commandTask('Area Mine', async () => {
        state.setState(STATES.MINING, 'area');
        say(bot, 'Area mining at ' + round1(x) + ' ' + round1(y) + ' ' + round1(z) + ' radius ' + radius + '.');
        await survival.mineArea(bot, x, y, z, radius);
        say(bot, 'Area mine complete.');
      });
    }

    case 'mineblock': {
      const block  = intent.block;
      const amount = intent.amount;
      if (!bot.registry || !bot.registry.blocksByName[block]) {
        say(bot, 'Unknown block "' + block + '". Check the name and try again.');
        return false;
      }

      return commandTask('Mine ' + block, async () => {
        state.setState(STATES.MINING, block);

        // ── Full Area Scan ────────────────────────────────────────────────
        // Start the scanner (idempotent) and run an immediate scan so the
        // block map is fresh before we decide whether to proceed or wander.
        const scanner = getScanner();
        if (!scanner.isActive()) scanner.start(bot);

        say(bot, 'Running full area scan (' + SCAN_RANGE + ' block radius)…');
        await scanner.scanNow(bot);

        if (!scanner.hasBlock(block)) {
          // Block not found — ask the user if they want wander-search
          const found = scanner.getSummary();
          say(bot,
            "I've scanned the area and I can't find [" + block + ']. '
            + 'Scan found: ' + (found || 'nothing valuable nearby') + '.'
          );
          say(bot, 'Should I start wandering to search for it? Reply YES or NO.');
          if (ctx.manager) {
            ctx.manager._pendingWanderSearch = {
              username,
              blockName: block,
              expires:   Date.now() + 60000   // 60 s window to reply
            };
          }
          return; // exit this task — wander will be triggered by yes/no
        }

        // Block is in the scan map — report position and mine
        const hit = scanner.getClosest(bot, block);
        if (hit) {
          say(bot,
            'Scan found ' + hit.blockName + ' at '
            + round1(hit.x) + ' ' + round1(hit.y) + ' ' + round1(hit.z)
            + ' (' + hit.dist + ' blocks). Proceeding to mine.'
          );
        } else {
          say(bot, 'Block detected in scan map. Mining up to ' + amount + ' x ' + block + '…');
        }

        const result = await survival.mineBlockByName(bot, block, amount, (count) => {
          say(bot, 'Progress: ' + count + ' / ' + amount + ' ' + block + ' mined.');
        });

        const n = result.mined;
        if (result.reason === 'target_reached') {
          say(bot, 'Done: ' + n + ' x ' + block + ' collected.');
        } else if (result.reason === 'inventory_full') {
          say(bot, 'Inventory full — stopped at ' + n + ' x ' + block + '.');
        } else if (result.reason === 'none_found') {
          // Re-check scanner — it might have been cleared between scan and dig
          say(bot, n > 0
            ? 'No more ' + block + ' in range. Collected ' + n + ' x ' + block + '.'
            : "Scan showed " + block + " but couldn't reach it. Try !mineblock again."
          );
        } else {
          say(bot, 'Mining stopped. Collected ' + n + ' x ' + block + '.');
        }
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // MISC / UTILITY
    // ════════════════════════════════════════════════════════════════════════

    case 'jump':
      return commandTask('Jump', async () => {
        bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 400));
        bot.setControlState('jump', false);
      });

    case 'look':
      return commandTask('Survey', async () => {
        bot.look(Math.random() * Math.PI * 2, 0, true);
        say(bot, 'Scanning surroundings.');
      });

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

    // ════════════════════════════════════════════════════════════════════════
    // BUILDING
    // ════════════════════════════════════════════════════════════════════════

    case 'build':
      return commandTask('Build ' + intent.structure, async () => {
        let result;
        switch (intent.structure) {
          case 'wall':   result = await buildWall(bot, state);   break;
          case 'bridge': result = await buildBridge(bot, state); break;
          case 'house':  result = await buildHouse(bot, state);  break;
          default: say(bot, 'Unknown structure. Choose: wall, bridge, house.'); return;
        }
        say(bot,
          'Build complete — placed ' + result.placed + ' ' + result.mat +
          ' blocks (' + result.type + ').'
        );
      });

    // ════════════════════════════════════════════════════════════════════════
    // AUTO BUILD — schematic executor
    // ════════════════════════════════════════════════════════════════════════

    case 'build_schematic': {
      const schemName = intent.schematicName;
      // Validate the name before queuing
      const available = autoBuild.listSchematics();
      if (!available.includes(schemName)) {
        say(bot, 'Unknown schematic "' + schemName + '". Available: ' + available.join(', ') + '. Or use /bot-api/build/run with a custom JSON schematic.');
        return false;
      }
      return commandTask('Build Schematic: ' + schemName, async () => {
        say(bot, 'Loading schematic "' + schemName + '"…');
        const result = await autoBuild.executeBuild(bot, schemName, {
          onLog: (msg) => { if (ctx.manager) ctx.manager.log(msg); },
          onProgress: ({ placed, total }) => {
            if (placed > 0 && placed % 10 === 0) {
              say(bot, 'Building… ' + placed + ' / ' + total + ' blocks placed.');
            }
          },
          state,
          pullChest: true
        });
        say(bot,
          'Build "' + schemName + '" done — ' +
          result.placed  + ' placed, ' +
          result.skipped + ' already filled, ' +
          result.failed  + ' failed.' +
          (result.cancelled ? ' (cancelled early)' : '')
        );
        if (Object.keys(result.missing).length > 0) {
          const mis = Object.entries(result.missing).map(([t, c]) => c + '×' + t).join(', ');
          say(bot, 'Missing materials were: ' + mis);
        }
      });
    }

    case 'build_stop': {
      const stopped = autoBuild.cancelBuild();
      say(bot, stopped ? 'Build cancelled.' : 'No active build to cancel.');
      return true;
    }

    case 'build_status': {
      const st = autoBuild.getBuildStatus();
      if (!st.active) {
        say(bot, 'No active build session.');
      } else {
        say(bot,
          'Building "' + st.name + '": ' +
          st.placed + '/' + st.total + ' placed, ' +
          st.failed + ' failed, ' +
          st.remaining + ' remaining.'
        );
      }
      return true;
    }

    case 'build_list': {
      say(bot, 'Built-in schematics: ' + autoBuild.listSchematics().join(', '));
      return true;
    }

    // ════════════════════════════════════════════════════════════════════════
    // DEBUG / DEV TOOLS
    // ════════════════════════════════════════════════════════════════════════

    case 'debug': {
      if (ctx.manager) ctx.manager._debugMode = intent.enabled;
      say(bot, 'Debug mode ' + (intent.enabled ? 'ON — verbose logging active.' : 'OFF.'));
      return true;
    }

    case 'tasklist': {
      const snap = queue.snapshot();
      if (!snap.currentTask && snap.pending.length === 0) {
        const mode = (ctx.manager && ctx.manager._botMode) || 'idle';
        say(bot, 'Task queue empty. State: ' + state.getState().state + ' | Mode: ' + mode);
      } else {
        const pending = snap.pending.length > 0 ? ' | Queued: ' + snap.pending.slice(0, 5).join(', ') : '';
        say(bot, 'Current: ' + (snap.currentTask || 'none') + pending);
      }
      return true;
    }

    case 'cleartasks': {
      clearMode(ctx);
      stopGuardianMode(ctx);
      queue.clear();
      pathfinding.stop(bot);
      state.reset('tasks cleared');
      say(bot, 'Task queue cleared and mode reset. Bot is idle.');
      return true;
    }

    case 'log_view': {
      const logStatus = ctx.manager && ctx.manager.getStatus ? ctx.manager.getStatus() : {};
      const logEntries = Array.isArray(logStatus.logs) ? logStatus.logs : [];
      const recent = logEntries.slice(-(intent.count || 5));
      if (recent.length === 0) {
        say(bot, 'No recent log entries available.');
      } else {
        recent.forEach(entry => {
          const msg = entry.message || String(entry);
          say(bot, msg.slice(0, 100));
        });
      }
      return true;
    }

    // ════════════════════════════════════════════════════════════════════════
    // ROLE MANAGEMENT
    // ════════════════════════════════════════════════════════════════════════

    case 'add_admin': {
      const targetName = intent.target;
      const cfg = roles.getConfig();
      if (targetName === cfg.ownerMcName) { say(bot, 'Cannot modify the Owner.'); return false; }
      const targetTier = roles.getMcTier(targetName);
      if (targetTier === roles.TIERS.ADMIN) { say(bot, targetName + ' is already an Admin.'); return false; }
      roles.addToRole('adminMcNames', targetName);
      roles.removeFromRole('managerMcNames', targetName);
      say(bot, 'Granted Admin role to ' + targetName + '. Full access enabled.');
      return true;
    }

    case 'remove_admin': {
      const targetName = intent.target;
      const cfg = roles.getConfig();
      if (targetName === cfg.ownerMcName) { say(bot, 'Cannot modify the Owner.'); return false; }
      const removed = roles.removeFromRole('adminMcNames', targetName);
      if (!removed) { say(bot, targetName + ' is not an Admin.'); return false; }
      say(bot, 'Revoked Admin role from ' + targetName + '.');
      return true;
    }

    case 'add_manager': {
      const targetName = intent.target;
      const targetTier = roles.getMcTier(targetName);
      if (!roles.canModifyTier(userTier, targetTier)) {
        say(bot, 'Hierarchy violation — ' + targetName + ' is ' + roles.tierName(targetTier) + ' (>= your tier).');
        return false;
      }
      const added = roles.addToRole('managerMcNames', targetName);
      if (!added) { say(bot, targetName + ' is already a Manager.'); return false; }
      say(bot, 'Granted Manager role to ' + targetName + '.');
      return true;
    }

    case 'remove_manager': {
      const targetName = intent.target;
      const targetTier = roles.getMcTier(targetName);
      if (!roles.canModifyTier(userTier, targetTier)) {
        say(bot, 'Hierarchy violation — ' + targetName + ' is ' + roles.tierName(targetTier) + ' (>= your tier).');
        return false;
      }
      const removed = roles.removeFromRole('managerMcNames', targetName);
      if (!removed) { say(bot, targetName + ' is not a Manager.'); return false; }
      say(bot, 'Revoked Manager role from ' + targetName + '.');
      return true;
    }

    // ════════════════════════════════════════════════════════════════════════
    // AI BRAIN — LLM GOAL PLANNER
    // ════════════════════════════════════════════════════════════════════════

    case 'ai_goal': {
      const goalText = intent.goal;
      if (!goalText) { say(bot, 'Usage: !ai <your goal>'); return false; }
      // Goal planner manages the task queue directly — do NOT wrap in commandTask
      // to avoid a deadlock (commandTask blocks queue; planner pushes into same queue)
      if (ctx.manager && ctx.manager.tryCommandCooldown) {
        if (!ctx.manager.tryCommandCooldown()) {
          say(bot, 'Cooldown active — wait a moment, ' + greet(userTier) + '.');
          return false;
        }
      }
      if (ctx.manager && ctx.manager.commandInterrupt) ctx.manager.commandInterrupt();
      const { think: _decThink } = require('../ai/decisionEngine');
      const _snap = bot && bot.entity ? _decThink(bot) : null;
      goalPlanner.setGoal(ctx, goalText, (msg) => say(bot, msg), _snap)
        .catch(err => say(bot, 'AI error: ' + (err && err.message ? err.message.slice(0, 80) : 'unknown')));
      return true;
    }

    case 'ai_stop': {
      goalPlanner.clearGoal(ctx, (msg) => say(bot, msg));
      return true;
    }

    case 'ai_chat': {
      if (ctx.manager) ctx.manager.llmChatEnabled = Boolean(intent.enabled);
      say(bot, '[FAERO] AI chat: ' + (intent.enabled ? 'ON — say my name to talk' : 'OFF'));
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
    return 'Path blocked — cannot find a safe route.';
  if (msg.includes('lava') || msg.includes('fire'))
    return 'Route blocked by lava or fire.';
  if (msg.includes('inventory') || msg.includes('full'))
    return 'Inventory full — drop some items and retry.';
  if (msg.includes('too far') || msg.includes('distance'))
    return 'Target is too far away.';
  if (msg.includes('not found') || msg.includes('no block') || msg.includes('no target'))
    return 'Target not found nearby.';
  if (msg.includes('safety blocked') || msg.includes('pvp'))
    return 'Action blocked — PvP is disabled or target is not an enemy.';
  if (msg.includes('timeout'))
    return 'Action timed out and was aborted.';
  if (msg.includes('materials') || msg.includes('blocks of'))
    return err.message;
  return (err && err.message) ? err.message : 'Unexpected error.';
}

module.exports = { handleChat, handleCommand, isAuthorized: () => false };
