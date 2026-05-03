'use strict';

/**
 * FAERO — Goal Planner (ai/goalPlanner.js)
 *
 * Translates a free-text goal into an ordered list of concrete steps and
 * executes them sequentially.  The LLM returns a JSON step array; each step
 * maps to one ACTION_HANDLER.
 *
 * Bug-fixes vs original:
 *   • craft — now finds a nearby crafting table (required for 3x3 recipes)
 *   • smelt — new action: put items in a nearby furnace and wait for output
 *
 * New exports: getGoalStatus() — snapshot for dashboard / REST endpoint
 */

const llm            = require('./llmClient');
const contextBuilder = require('./contextBuilder');
const survival       = require('../modules/survival');
const pathfinding    = require('../modules/pathfinding');
const combatAI       = require('../modules/combatAI');
const { STATES }     = require('../core/stateManager');

// ── Action executor map ───────────────────────────────────────────────────────

const ACTION_HANDLERS = {

  mine_block: async (bot, params, ctx) => {
    const block  = String(params.block || 'iron_ore').toLowerCase().replace(/\s+/g, '_');
    const amount = Math.max(1, Math.min(Number(params.amount) || 16, 64));
    ctx.stateManager && ctx.stateManager.setState(STATES.MINING, 'llm:mine_block');
    const result = await survival.mineBlockByName(bot, block, amount, (count) => {
      if (ctx.manager) ctx.manager.log('[goal] Mined ' + count + '/' + amount + ' ' + block);
    });
    return 'Mined ' + result.mined + ' ' + block + ' (' + result.reason + ')';
  },

  collect_food: async (bot, _params, ctx) => {
    ctx.stateManager && ctx.stateManager.setState(STATES.FARMING, 'llm:collect_food');
    await survival.collectFood(bot);
    return 'Food collection complete';
  },

  collect_resources: async (bot, _params, ctx) => {
    ctx.stateManager && ctx.stateManager.setState(STATES.MINING, 'llm:collect_resources');
    await survival.collectNearbyResources(bot);
    return 'Collected nearby resources';
  },

  eat: async (bot) => {
    await survival.autoEat(bot);
    return 'Ate food';
  },

  go_to: async (bot, params, ctx) => {
    const x = Number(params.x);
    const y = Number(params.y);
    const z = Number(params.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('go_to: invalid coordinates');
    ctx.stateManager && ctx.stateManager.setState(STATES.FOLLOWING, 'llm:go_to');
    await pathfinding.goToCoords(bot, x, Number.isFinite(y) ? y : bot.entity.position.y, z, 2);
    return 'Arrived at ' + Math.round(x) + ' ' + Math.round(z);
  },

  attack_mob: async (bot, params, ctx) => {
    const name = String(params.mob || params.name || '').toLowerCase().replace(/\s+/g, '_');
    if (!name) throw new Error('attack_mob: no mob name');
    ctx.stateManager && ctx.stateManager.setState(STATES.FIGHTING, 'llm:attack_mob');
    const result = await combatAI.engageMobByName(bot, name, {});
    return 'Combat result: ' + result.result + (result.looted ? ' (looted)' : '');
  },

  /**
   * craft — craft an item at a nearby crafting table (or 2x2 if no table needed).
   * Fix: searches for a crafting_table block within 6 blocks and uses it so that
   * 3x3 recipes (iron_pickaxe, iron_sword, etc.) work correctly.
   */
  craft: async (bot, params, ctx) => {
    const itemName = String(params.item || '').toLowerCase().replace(/\s+/g, '_');
    if (!itemName) throw new Error('craft: no item specified');
    const itemDef = bot.registry && bot.registry.itemsByName[itemName];
    if (!itemDef) throw new Error('craft: unknown item ' + itemName);

    // Find nearby crafting table
    let craftingTable = null;
    if (bot.registry) {
      const tableBlock = bot.registry.blocksByName['crafting_table'];
      if (tableBlock) {
        craftingTable = bot.findBlock({ matching: tableBlock.id, maxDistance: 6 });
      }
    }

    // If no table found for a 3x3 recipe, try navigating to one farther away
    if (!craftingTable) {
      if (ctx.manager) ctx.manager.log('[goal] No crafting table nearby — trying up to 32 blocks');
      const tableBlock = bot.registry && bot.registry.blocksByName['crafting_table'];
      if (tableBlock) {
        craftingTable = bot.findBlock({ matching: tableBlock.id, maxDistance: 32 });
        if (craftingTable) {
          await pathfinding.goToCoords(
            bot,
            craftingTable.position.x,
            craftingTable.position.y,
            craftingTable.position.z,
            2
          );
        }
      }
    }

    const recipe = bot.recipesFor(itemDef.id, null, 1, craftingTable || null)[0];
    if (!recipe) {
      throw new Error(
        'craft: no recipe for ' + itemName +
        (craftingTable ? '' : ' (no crafting table found — place one nearby)')
      );
    }
    await bot.craft(recipe, 1, craftingTable || null);
    return 'Crafted ' + itemName;
  },

  /**
   * smelt — put an input item into a nearby furnace and wait for output.
   * Requires a furnace within 8 blocks.  Fuel is added automatically if the
   * fuel slot is empty (coal → charcoal → planks → logs tried in order).
   *
   * Params: { input: "raw_iron", amount: 3 }
   * Output item examples: raw_iron → iron_ingot, raw_copper → copper_ingot,
   *                       sand → glass, cobblestone → stone, oak_log → charcoal
   */
  smelt: async (bot, params, ctx) => {
    const inputName = String(params.input || params.item || '').toLowerCase().replace(/\s+/g, '_');
    const amount    = Math.max(1, Math.min(Number(params.amount) || 1, 8));
    if (!inputName) throw new Error('smelt: no input specified');

    // Find furnace (lit or unlit)
    const furnaceIds = ['furnace', 'lit_furnace', 'blast_furnace', 'lit_blast_furnace', 'smoker', 'lit_smoker']
      .map(n => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id)
      .filter(Boolean);

    const furnaceBlock = bot.findBlock({
      matching: (b) => furnaceIds.includes(b.type),
      maxDistance: 8
    });
    if (!furnaceBlock) throw new Error('smelt: no furnace within 8 blocks — place a furnace first');

    // Navigate to furnace
    await pathfinding.goToCoords(
      bot,
      furnaceBlock.position.x,
      furnaceBlock.position.y,
      furnaceBlock.position.z,
      2
    );

    const inputDef = bot.registry.itemsByName[inputName];
    if (!inputDef) throw new Error('smelt: unknown item ' + inputName);

    const inputStack = bot.inventory.items().find(i => i.type === inputDef.id);
    if (!inputStack) throw new Error('smelt: no ' + inputName + ' in inventory');

    const furnace = await bot.openFurnace(furnaceBlock);
    try {
      // Auto-add fuel if slot is empty
      if (!furnace.fuelItem()) {
        const fuelCandidates = [
          'coal', 'charcoal', 'coal_block',
          'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks',
          'oak_log', 'birch_log', 'spruce_log'
        ];
        for (const fn of fuelCandidates) {
          const fd = bot.registry.itemsByName[fn];
          if (!fd) continue;
          const fs = bot.inventory.items().find(i => i.type === fd.id);
          if (fs) {
            await furnace.putFuel(fd.id, null, Math.min(fs.count, 8));
            break;
          }
        }
      }

      const toSmelt = Math.min(amount, inputStack.count);
      await furnace.putInput(inputDef.id, null, toSmelt);

      // Poll until output appears or timeout
      const deadline = Date.now() + Math.min(toSmelt * 12000 + 8000, 70000);
      while (Date.now() < deadline) {
        await sleep(2500);
        const out = furnace.outputItem();
        if (out && out.count >= 1) break;
      }

      let took = null;
      try { took = await furnace.takeOutput(); } catch (_) {}
      return 'Smelted ' + toSmelt + ' ' + inputName +
             (took ? ' → ' + took.count + ' ' + (took.name || '') : '');
    } finally {
      furnace.close();
    }
  },

  go_home: async (bot, _params, ctx) => {
    ctx.stateManager && ctx.stateManager.setState(STATES.FOLLOWING, 'llm:go_home');
    try {
      const models = require('../lib/persistence/models');
      const home   = await models.findLocation(bot.username, 'home');
      if (home) {
        await pathfinding.goToCoords(bot, home.x, home.y, home.z, 2);
        return 'Returned home';
      }
    } catch (_) {}
    throw new Error('No home position set — use !sethome first');
  },

  idle: async (_bot, params) => {
    const secs = Math.max(1, Math.min(Number(params.seconds) || 3, 30));
    await new Promise(r => setTimeout(r, secs * 1000));
    return 'Waited ' + secs + 's';
  }
};

// ── System prompt ─────────────────────────────────────────────────────────────

const PLANNER_SYSTEM = `You are FAERO's goal planner. Given a free-text goal and bot state, return ONLY a JSON array of steps.

Available actions:
- mine_block:       {action:"mine_block",      params:{block:"iron_ore",    amount:16},    description:"mine 16 iron ore"}
- collect_food:     {action:"collect_food",     params:{},                                 description:"gather food"}
- collect_resources:{action:"collect_resources",params:{},                                 description:"collect nearby resources"}
- eat:              {action:"eat",              params:{},                                 description:"eat food"}
- go_to:            {action:"go_to",            params:{x:100, y:64, z:-200},              description:"go to coords"}
- attack_mob:       {action:"attack_mob",       params:{mob:"zombie"},                     description:"fight zombie"}
- craft:            {action:"craft",            params:{item:"iron_pickaxe"},              description:"craft iron pickaxe"}
- smelt:            {action:"smelt",            params:{input:"raw_iron",amount:3},        description:"smelt 3 raw iron into iron ingots"}
- go_home:          {action:"go_home",          params:{},                                 description:"return to home"}
- idle:             {action:"idle",             params:{seconds:3},                        description:"wait 3 seconds"}

CRITICAL Minecraft rules to follow:
1. Mining iron_ore or deepslate_iron_ore gives RAW IRON (not iron_ore). You must smelt raw_iron → iron_ingot before crafting.
2. Similarly: raw_copper → copper_ingot, raw_gold → gold_ingot.
3. Both "iron_ore" and "deepslate_iron_ore" drop raw_iron — use iron_ore as the block name (the bot handles deepslate automatically).
4. Crafting iron_pickaxe requires 3 iron_ingot + 2 stick and a crafting table (3x3 grid).
5. Sticks come from crafting 2 planks (e.g. oak_planks). If the inventory probably has planks, skip the stick-crafting step.
6. Maximum 8 steps. Return ONLY valid JSON — no markdown, no explanation.
7. If goal is unclear, return a single idle step.

Example for "get iron and make a pickaxe":
[
  {"action":"mine_block","params":{"block":"iron_ore","amount":3},"description":"mine 3 iron ore (gives raw_iron)"},
  {"action":"smelt","params":{"input":"raw_iron","amount":3},"description":"smelt raw_iron into iron_ingot"},
  {"action":"craft","params":{"item":"stick"},"description":"craft sticks"},
  {"action":"craft","params":{"item":"iron_pickaxe"},"description":"craft iron pickaxe"}
]`;

// ── State ─────────────────────────────────────────────────────────────────────

let _activeGoal = null;   // {text, steps, stepIndex, startedAt}
let _executing  = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function noop()    {}

function emitGoalUpdate(ctx, runningStepIdx) {
  if (!ctx || !ctx.manager || typeof ctx.manager.emit !== 'function') return;
  if (!_activeGoal) {
    ctx.manager.emit('ai_goal_update', { running: false, goal: null });
    return;
  }
  ctx.manager.emit('ai_goal_update', {
    running: _executing,
    goal: {
      text:       _activeGoal.text,
      stepIndex:  _activeGoal.stepIndex,
      totalSteps: _activeGoal.steps.length,
      startedAt:  _activeGoal.startedAt,
      steps:      _activeGoal.steps.map((s, i) => ({
        description: s.description || s.action,
        action:      s.action,
        status: i < (runningStepIdx != null ? runningStepIdx : _activeGoal.stepIndex) ? 'done'
          : i === runningStepIdx ? 'running'
          : 'pending'
      }))
    }
  });
}

// ── Plan generation ───────────────────────────────────────────────────────────

async function generatePlan(ctx, goalText, snapshot) {
  const stateStr = contextBuilder.stringify(ctx, snapshot, goalText);
  const messages = [
    { role: 'system', content: PLANNER_SYSTEM },
    { role: 'user',   content: 'Bot state: ' + stateStr + '\n\nGoal: ' + goalText }
  ];
  const raw  = await llm.complete(messages, { maxTokens: 500, timeoutMs: 15000 });
  const plan = llm.extractJSON(raw);
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error('LLM returned invalid plan: ' + String(raw).slice(0, 80));
  }
  return plan;
}

// ── Public API ─────────────────────────────────────────────────────────────────

async function setGoal(ctx, goalText, sayFn, snapshot) {
  const say = sayFn || noop;
  if (!llm.isAvailable()) {
    say('LLM not configured — set GROQ_API_KEY or DEEPSEEK_API_KEY in secrets.');
    return;
  }

  _activeGoal = null;
  _executing  = false;
  if (ctx.taskQueue) ctx.taskQueue.clear();

  // Notify dashboard that planning is starting
  if (ctx.manager && typeof ctx.manager.emit === 'function') {
    ctx.manager.emit('ai_goal_update', { running: true, planning: true, goalText });
  }

  say('Planning: "' + goalText + '" — one moment…');

  let plan;
  try {
    plan = await generatePlan(ctx, goalText, snapshot);
  } catch (err) {
    say('Plan failed: ' + err.message);
    if (ctx.manager) ctx.manager.log('[goal] Plan generation error: ' + err.message);
    if (ctx.manager && typeof ctx.manager.emit === 'function') {
      ctx.manager.emit('ai_goal_update', { running: false, goal: null, error: err.message });
    }
    return;
  }

  _activeGoal = { text: goalText, steps: plan, stepIndex: 0, startedAt: Date.now() };
  if (ctx.manager) ctx.manager.log('[goal] Plan ready (' + plan.length + ' steps): ' + plan.map(s => s.description || s.action).join(' → '));
  say('Goal set (' + plan.length + ' steps). Starting now.');

  emitGoalUpdate(ctx, 0);
  planAndExecute(ctx, say);
}

function planAndExecute(ctx, sayFn) {
  const say = sayFn || noop;
  if (_executing) return;
  if (!_activeGoal) return;

  _executing = true;

  (async () => {
    try {
      while (_activeGoal && _activeGoal.stepIndex < _activeGoal.steps.length) {
        const stepIdx = _activeGoal.stepIndex;
        const step    = _activeGoal.steps[stepIdx];
        const label   = step.description || step.action;

        if (ctx.manager) ctx.manager.log('[goal] Step ' + (stepIdx + 1) + '/' + _activeGoal.steps.length + ': ' + label);
        emitGoalUpdate(ctx, stepIdx);

        await new Promise((resolve) => {
          ctx.taskQueue.push('[AI] ' + label, async () => {
            const bot     = ctx.bot;
            const handler = ACTION_HANDLERS[step.action];
            if (!handler) throw new Error('Unknown action: ' + step.action);
            if (!bot || !bot.entity) throw new Error('Bot not in world');

            try {
              const result = await handler(bot, step.params || {}, ctx);
              if (ctx.manager) ctx.manager.log('[goal] ✓ ' + label + (result ? ' — ' + result : ''));
            } finally {
              if (_activeGoal) _activeGoal.stepIndex++;
              emitGoalUpdate(ctx, null);
              resolve();
            }
          }, { priority: 85 });
        });

        await sleep(600);
      }

      if (_activeGoal) {
        say('Goal complete: "' + _activeGoal.text + '"');
        if (ctx.manager) ctx.manager.log('[goal] Completed: ' + _activeGoal.text);
        const completedText = _activeGoal.text;
        _activeGoal = null;
        if (ctx.manager && typeof ctx.manager.emit === 'function') {
          ctx.manager.emit('ai_goal_update', { running: false, goal: null, completed: completedText });
        }
        ctx.stateManager && ctx.stateManager.reset('goal_complete');
      }
    } catch (err) {
      say('Goal error: ' + (err.message || 'unknown error'));
      if (ctx.manager) ctx.manager.log('[goal] Execution error: ' + err.message);
      _activeGoal = null;
      if (ctx.manager && typeof ctx.manager.emit === 'function') {
        ctx.manager.emit('ai_goal_update', { running: false, goal: null, error: err.message });
      }
      ctx.stateManager && ctx.stateManager.reset('goal_error');
    } finally {
      _executing = false;
    }
  })();
}

function clearGoal(ctx, sayFn) {
  _activeGoal = null;
  _executing  = false;
  if (ctx && ctx.taskQueue) ctx.taskQueue.clear();
  ctx && ctx.stateManager && ctx.stateManager.reset('goal_cleared');
  if (sayFn) sayFn('Goal cleared.');
  if (ctx && ctx.manager && typeof ctx.manager.emit === 'function') {
    ctx.manager.emit('ai_goal_update', { running: false, goal: null });
  }
}

function executePlan(ctx, steps, goalText, sayFn) {
  if (!Array.isArray(steps) || !steps.length) return;
  const say = sayFn || noop;
  if (ctx.taskQueue) ctx.taskQueue.clear();
  _activeGoal = {
    text:      goalText || 'chat-initiated',
    steps,
    stepIndex: 0,
    startedAt: Date.now()
  };
  if (ctx.manager) ctx.manager.log('[goal] Chat-initiated plan (' + steps.length + ' steps)');
  emitGoalUpdate(ctx, 0);
  planAndExecute(ctx, say);
}

function getActiveGoal() { return _activeGoal; }
function isRunning()     { return _executing; }

function getGoalStatus() {
  if (!_activeGoal) return { running: false, goal: null };
  return {
    running: _executing,
    goal: {
      text:       _activeGoal.text,
      stepIndex:  _activeGoal.stepIndex,
      totalSteps: _activeGoal.steps.length,
      startedAt:  _activeGoal.startedAt,
      steps:      _activeGoal.steps.map((s, i) => ({
        description: s.description || s.action,
        action:      s.action,
        status: i < _activeGoal.stepIndex ? 'done'
          : i === _activeGoal.stepIndex && _executing ? 'running'
          : 'pending'
      }))
    }
  };
}

module.exports = { setGoal, clearGoal, executePlan, planAndExecute, getActiveGoal, isRunning, getGoalStatus };
