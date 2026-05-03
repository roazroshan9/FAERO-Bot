'use strict';

/**
 * FAERO — Goal Planner (ai/goalPlanner.js)
 *
 * Translates a free-text goal (e.g. "find iron, craft a pickaxe, come back")
 * into an ordered list of concrete steps and executes them sequentially in
 * the bot's task queue.
 *
 * Flow:
 *   1. Caller sets a goal via setGoal(ctx, goalText, sayFn)
 *   2. planAndExecute() calls the LLM with a structured prompt
 *   3. LLM returns a JSON step list: [{action, params, description}, ...]
 *   4. Steps are pushed to ctx.taskQueue in order, each running the matching
 *      ACTION_HANDLER function from existing modules
 *   5. Progress + completion are announced via sayFn (in-game chat)
 *
 * Available actions the LLM can use:
 *   mine_block      — mine N of a specific block (e.g. iron_ore, diamond_ore)
 *   collect_food    — gather/farm food items
 *   collect_resources — gather nearby resources
 *   eat             — eat until hunger satisfied
 *   go_to           — navigate to {x, y, z}
 *   attack_mob      — fight nearest mob matching name
 *   craft           — craft an item (best-effort, needs materials)
 *   go_home         — navigate to bot's saved home position
 *   idle            — wait N seconds
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

  craft: async (bot, params) => {
    const itemName = String(params.item || '').toLowerCase().replace(/\s+/g, '_');
    if (!itemName) throw new Error('craft: no item specified');
    const itemDef = bot.registry && bot.registry.itemsByName[itemName];
    if (!itemDef) throw new Error('craft: unknown item ' + itemName);
    const recipe = bot.recipesFor(itemDef.id, null, 1, null)[0];
    if (!recipe) throw new Error('craft: no recipe found for ' + itemName + ' (missing materials or table)');
    await bot.craft(recipe, 1, null);
    return 'Crafted ' + itemName;
  },

  go_home: async (bot, _params, ctx) => {
    ctx.stateManager && ctx.stateManager.setState(STATES.FOLLOWING, 'llm:go_home');
    // Try to resolve home from persistence
    try {
      const models = require('../lib/persistence/models');
      const home = await models.findLocation(bot.username, 'home');
      if (home) {
        await pathfinding.goToCoords(bot, home.x, home.y, home.z, 2);
        return 'Returned home';
      }
    } catch (_) {}
    throw new Error('No home position set. Use !sethome first.');
  },

  idle: async (_bot, params) => {
    const secs = Math.max(1, Math.min(Number(params.seconds) || 3, 30));
    await new Promise(r => setTimeout(r, secs * 1000));
    return 'Waited ' + secs + 's';
  }
};

// ── System prompt for the planner ─────────────────────────────────────────────

const PLANNER_SYSTEM = `You are FAERO's goal planner. Given a free-text goal and bot state, return ONLY a JSON array of steps to execute in order.

Available actions:
- mine_block:       {action:"mine_block",      params:{block:"iron_ore",    amount:16},    description:"mine 16 iron ore"}
- collect_food:     {action:"collect_food",     params:{},                                 description:"gather food"}
- collect_resources:{action:"collect_resources",params:{},                                 description:"collect nearby resources"}
- eat:              {action:"eat",              params:{},                                 description:"eat food"}
- go_to:            {action:"go_to",            params:{x:100, y:64, z:-200},              description:"go to coords"}
- attack_mob:       {action:"attack_mob",       params:{mob:"zombie"},                     description:"fight zombie"}
- craft:            {action:"craft",            params:{item:"iron_pickaxe"},              description:"craft iron pickaxe"}
- go_home:          {action:"go_home",          params:{},                                 description:"return to home"}
- idle:             {action:"idle",             params:{seconds:3},                        description:"wait 3 seconds"}

Rules:
1. Return ONLY valid JSON — no markdown, no explanation, no extra text.
2. Maximum 8 steps. Keep it focused and achievable.
3. Use exact block/item names from Minecraft Java Edition (e.g. iron_ore, diamond_pickaxe).
4. If the goal is unclear or impossible, return a single idle step with a helpful description.
5. If crafting is needed, mine materials first.

Example output for "get 10 iron and make a pickaxe":
[
  {"action":"mine_block","params":{"block":"iron_ore","amount":10},"description":"mine 10 iron ore"},
  {"action":"craft","params":{"item":"iron_pickaxe"},"description":"craft iron pickaxe"}
]`;

// ── State ─────────────────────────────────────────────────────────────────────

let _activeGoal  = null;  // {text, steps, stepIndex, startedAt}
let _executing   = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function noop() {}

// ── Plan generation ───────────────────────────────────────────────────────────

async function generatePlan(ctx, goalText, snapshot) {
  const stateStr = contextBuilder.stringify(ctx, snapshot, goalText);
  const messages = [
    { role: 'system', content: PLANNER_SYSTEM },
    { role: 'user',   content: 'Bot state: ' + stateStr + '\n\nGoal: ' + goalText }
  ];
  const raw  = await llm.complete(messages, { maxTokens: 400, timeoutMs: 15000 });
  const plan = llm.extractJSON(raw);
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error('LLM returned invalid plan: ' + String(raw).slice(0, 80));
  }
  return plan;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Set (or replace) the active goal and immediately start planning + executing.
 *
 * @param {object}   ctx      — botManager.getContext()
 * @param {string}   goalText — free-text goal from player command
 * @param {Function} [sayFn]  — bot.chat wrapper for status messages
 * @param {object}   [snapshot] — optional decisionEngine snapshot for context
 */
async function setGoal(ctx, goalText, sayFn, snapshot) {
  const say = sayFn || noop;
  if (!llm.isAvailable()) {
    say('LLM not configured — set GROQ_API_KEY or DEEPSEEK_API_KEY in secrets.');
    return;
  }

  // Cancel previous goal
  _activeGoal = null;
  if (ctx.taskQueue) ctx.taskQueue.clear();

  say('Planning: "' + goalText + '" — one moment…');

  let plan;
  try {
    plan = await generatePlan(ctx, goalText, snapshot);
  } catch (err) {
    say('Plan failed: ' + err.message);
    if (ctx.manager) ctx.manager.log('[goal] Plan generation error: ' + err.message);
    return;
  }

  _activeGoal = { text: goalText, steps: plan, stepIndex: 0, startedAt: Date.now() };
  if (ctx.manager) ctx.manager.log('[goal] Plan ready (' + plan.length + ' steps): ' + plan.map(s => s.description || s.action).join(' → '));
  say('Goal set (' + plan.length + ' steps). Starting now.');

  planAndExecute(ctx, say);
}

/**
 * Execute the active plan step by step via the task queue.
 * Called internally after setGoal; safe to call externally to resume.
 */
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
              resolve();
            }
          }, { priority: 85 });
        });

        // Small gap between steps so the server doesn't get spammed
        await sleep(600);
      }

      // Goal complete
      if (_activeGoal) {
        say('Goal complete: "' + _activeGoal.text + '"');
        if (ctx.manager) ctx.manager.log('[goal] Completed: ' + _activeGoal.text);
        _activeGoal = null;
        ctx.stateManager && ctx.stateManager.reset('goal_complete');
      }
    } catch (err) {
      say('Goal error: ' + (err.message || 'unknown error'));
      if (ctx.manager) ctx.manager.log('[goal] Execution error: ' + err.message);
      _activeGoal = null;
      ctx.stateManager && ctx.stateManager.reset('goal_error');
    } finally {
      _executing = false;
    }
  })();
}

/**
 * Cancel the active goal and clear the queue.
 */
function clearGoal(ctx, sayFn) {
  _activeGoal = null;
  _executing  = false;
  if (ctx && ctx.taskQueue) ctx.taskQueue.clear();
  ctx && ctx.stateManager && ctx.stateManager.reset('goal_cleared');
  if (sayFn) sayFn('Goal cleared.');
}

function getActiveGoal() { return _activeGoal; }
function isRunning()     { return _executing; }

/**
 * Execute a pre-generated plan (bypasses the LLM planning step).
 * Used when chatResponder already embedded a plan in its JSON reply.
 *
 * @param {object}   ctx      — botManager.getContext()
 * @param {Array}    steps    — [{action, params, description}, ...]
 * @param {string}   goalText — human-readable label for logs
 * @param {Function} [sayFn]  — in-game chat callback
 */
function executePlan(ctx, steps, goalText, sayFn) {
  if (!Array.isArray(steps) || !steps.length) return;
  const say = sayFn || noop;
  if (ctx.taskQueue) ctx.taskQueue.clear();
  _activeGoal = {
    text: goalText || 'chat-initiated',
    steps,
    stepIndex: 0,
    startedAt: Date.now()
  };
  if (ctx.manager) ctx.manager.log('[goal] Chat-initiated plan (' + steps.length + ' steps)');
  planAndExecute(ctx, say);
}

module.exports = { setGoal, clearGoal, executePlan, planAndExecute, getActiveGoal, isRunning };
