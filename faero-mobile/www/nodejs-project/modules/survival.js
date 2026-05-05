const { goals } = require('mineflayer-pathfinder');
const pathfinding = require('./pathfinding');
const inventory = require('./inventory');
const combat = require('./combat');
const antiDetection = require('./antiDetection');
// Note: hasAnyPickaxe / ensurePickaxe are exported from this file (defined below)

const FOOD_ITEMS = [
  'bread',
  'apple',
  'carrot',
  'potato',
  'beef',
  'porkchop',
  'chicken',
  'mutton',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_chicken',
  'cooked_mutton',
  'wheat'
];

const ANIMALS = ['cow', 'pig', 'chicken', 'sheep'];

const ORE_PRIORITY = [
  'ancient_debris',
  'diamond_ore',
  'deepslate_diamond_ore',
  'emerald_ore',
  'deepslate_emerald_ore',
  'gold_ore',
  'deepslate_gold_ore',
  'nether_gold_ore',
  'iron_ore',
  'deepslate_iron_ore',
  'coal_ore',
  'deepslate_coal_ore',
  'redstone_ore',
  'deepslate_redstone_ore',
  'lapis_ore',
  'deepslate_lapis_ore',
  'copper_ore',
  'deepslate_copper_ore',
  'nether_quartz_ore'
];

async function configure(bot) {
  if (bot.autoEat) {
    bot.autoEat.options = {
      priority: 'foodPoints',
      startAt: 14,
      bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish']
    };
  }
}

// ─── Auto-Craft for Broken Tools ────────────────────────────────────────────
// During !mode mine, the survival loop can call ensurePickaxe(bot) before each
// dig pass. It detects when the bot has no pickaxe (just broke) and tries to
// craft a new wooden_pickaxe from any nearby crafting_table + planks/sticks.

const PICKAXE_NAMES = [
  'netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe',
  'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe'
];

function _findCraftingTable(bot) {
  const id = bot.registry && bot.registry.blocksByName.crafting_table;
  if (!id) return null;
  return bot.findBlock({ matching: id.id, maxDistance: 8 });
}

function hasAnyPickaxe(bot) {
  return bot.inventory.items().some(i => PICKAXE_NAMES.includes(i.name));
}

async function ensurePickaxe(bot) {
  if (!bot || !bot.entity) return { ok: false, reason: 'no_bot' };
  if (hasAnyPickaxe(bot)) return { ok: true, reason: 'already_have' };

  const recipeName = (() => {
    const reg = bot.registry;
    if (reg.itemsByName.stone_pickaxe && inventory.countItem(bot, ['cobblestone']) >= 3) return 'stone_pickaxe';
    if (reg.itemsByName.wooden_pickaxe) return 'wooden_pickaxe';
    return null;
  })();
  if (!recipeName) return { ok: false, reason: 'no_materials' };

  const itemDef = bot.registry.itemsByName[recipeName];
  const table = _findCraftingTable(bot);
  const recipe = bot.recipesFor(itemDef.id, null, 1, table || null)[0];
  if (!recipe) return { ok: false, reason: 'no_recipe' };

  try {
    if (table && bot.entity.position.distanceTo(table.position) > 3) {
      await pathfinding.goToCoords(bot, table.position.x, table.position.y, table.position.z, 2);
    }
    await bot.craft(recipe, 1, table || null);
    return { ok: true, reason: 'crafted', tool: recipeName };
  } catch (err) {
    return { ok: false, reason: 'craft_failed:' + (err && err.message ? err.message : 'unknown') };
  }
}

async function autoEat(bot) {
  if (bot.food === undefined || bot.food > 14) return;
  if (bot.autoEat && bot.autoEat.eat) {
    await bot.autoEat.eat();
    return;
  }
  const food = inventory.findItem(bot, FOOD_ITEMS);
  if (!food) return;
  await bot.equip(food, 'hand');
  await bot.consume();
}

async function equipArmor(bot) {
  if (bot.armorManager && bot.armorManager.equipAll) {
    await bot.armorManager.equipAll();
  }
}

async function collectDroppedFood(bot) {
  const item = bot.nearestEntity((entity) => {
    if (entity.name !== 'item' || !entity.metadata) return false;
    return bot.entity.position.distanceTo(entity.position) <= 16;
  });
  if (!item) return false;
  pathfinding.setupMovements(bot);
  await bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 1));
  return true;
}

async function craftBread(bot) {
  const wheat = inventory.countItem(bot, 'wheat');
  if (wheat < 3) return false;
  const bread = bot.registry.itemsByName.bread;
  if (!bread) return false;
  const recipe = bot.recipesFor(bread.id, null, 1, null)[0];
  if (!recipe) return false;
  await bot.craft(recipe, Math.floor(wheat / 3), null);
  return true;
}

async function farmWheat(bot) {
  const wheat = pathfinding.nearestBlock(bot, ['wheat'], 48);
  if (!wheat) return false;
  if (wheat.metadata !== undefined && wheat.metadata < 7) return false;
  await mineBlockObject(bot, wheat);
  return true;
}

async function huntAnimals(bot) {
  const animal = bot.nearestEntity((entity) => {
    return ANIMALS.includes(entity.name) && bot.entity.position.distanceTo(entity.position) <= 32;
  });
  if (!animal) return false;
  await combat.attackMob(bot, animal);
  return true;
}

async function collectFood(bot) {
  await collectDroppedFood(bot);
  await craftBread(bot);
  if (inventory.countItem(bot, ['bread', 'apple', 'carrot', 'potato']) >= 16) return;
  const farmed = await farmWheat(bot);
  if (farmed) {
    await craftBread(bot);
    return;
  }
  await huntAnimals(bot);
}

async function collectNearbyResources(bot) {
  if (!bot.collectBlock) return false;
  const block = findPriorityOre(bot, 16) || pathfinding.nearestBlock(bot, ['oak_log', 'spruce_log', 'birch_log', 'stone'], 16);
  if (!block) return false;
  await bot.collectBlock.collect(block);
  return true;
}

function findPriorityOre(bot, maxDistance) {
  const names = ORE_PRIORITY.slice(0, 8);
  for (const name of names) {
    const block = pathfinding.nearestBlock(bot, [name], Math.min(Number(maxDistance) || 24, 24));
    if (block) return block;
  }
  return null;
}

async function minePriorityOre(bot) {
  const ore = findPriorityOre(bot, 64);
  if (!ore) return false;
  await mineBlockObject(bot, ore);
  return true;
}

function isInventoryFull(bot) {
  if (!bot.inventory) return false;
  return bot.inventory.items().length >= 35;
}

async function mineBlockObject(bot, block) {
  if (!block) return false;
  pathfinding.setupMovements(bot);
  await bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 1));
  await inventory.equipBestTool(bot, block);
  if (bot.canDigBlock(block)) {
    await bot.dig(block);
    return true;
  }
  return false;
}

/**
 * Mine up to `maxCount` of `blockName` near the bot.
 * Returns { mined: number, reason: 'target_reached'|'inventory_full'|'none_found'|'cannot_dig' }
 * Calls onProgress(count) every 16 blocks so the caller can broadcast progress chat.
 */
async function mineBlockByName(bot, blockName, maxCount, onProgress) {
  const limit = Math.max(1, Math.min(Number(maxCount) || 64, 256));
  let mined = 0;

  while (mined < limit) {
    if (isInventoryFull(bot)) return { mined, reason: 'inventory_full' };
    const block = pathfinding.nearestBlock(bot, [blockName], 32);
    if (!block) return { mined, reason: 'none_found' };
    const ok = await mineBlockObject(bot, block);
    if (!ok) return { mined, reason: 'cannot_dig' };
    mined++;
    if (typeof onProgress === 'function' && mined % 16 === 0 && mined < limit) {
      onProgress(mined);
    }
    // Jitter between digs — looks like a human pausing to check the block
    await antiDetection.jitter(120, 480);
  }

  return { mined, reason: 'target_reached' };
}

async function mineIron(bot) {
  return mineAnyByNames(bot, ['iron_ore', 'deepslate_iron_ore'], 32);
}

async function cutWood(bot) {
  let count = 0;
  for (const name of ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log']) {
    const result = await mineBlockByName(bot, name, 16);
    count += result.mined;
    if (count >= 16 || result.reason === 'inventory_full') break;
  }
  return count;
}

async function mineAnyByNames(bot, names, maxCount) {
  let mined = 0;
  const limit = Math.max(1, Math.min(Number(maxCount) || 16, 256));
  while (mined < limit) {
    if (isInventoryFull(bot)) break;
    let block = null;
    for (const name of names) {
      block = pathfinding.nearestBlock(bot, [name], 32);
      if (block) break;
    }
    if (!block) break;
    const ok = await mineBlockObject(bot, block);
    if (!ok) break;
    mined++;
    await antiDetection.jitter(110, 450);
  }
  return mined;
}

async function mineArea(bot, x, y, z, radius) {
  const positions = pathfinding.positionsAround({ x: Number(x), y: Number(y), z: Number(z) }, Math.max(3, Math.min(4, Number(radius) || 3)));
  const oreNames = {};
  ORE_PRIORITY.forEach((name, index) => {
    oreNames[name] = index;
  });
  const blocks = positions
    .map((pos) => bot.blockAt(pos))
    .filter((block) => block && block.name !== 'air' && block.name !== 'bedrock' && bot.canDigBlock(block))
    .sort((a, b) => {
      const ap = oreNames[a.name] === undefined ? 999 : oreNames[a.name];
      const bp = oreNames[b.name] === undefined ? 999 : oreNames[b.name];
      return ap - bp || b.position.y - a.position.y;
    });
  let mined = 0;
  for (const block of blocks) {
    try {
      await mineBlockObject(bot, block);
      mined++;
      if (mined >= 32) break;
    } catch (err) {
      continue;
    }
  }
  return mined;
}

async function survivalTick(bot) {
  await autoEat(bot);
  await equipArmor(bot);
  await inventory.dropUseless(bot);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  FOOD_ITEMS,
  ANIMALS,
  ORE_PRIORITY,
  PICKAXE_NAMES,
  hasAnyPickaxe,
  ensurePickaxe,
  configure,
  autoEat,
  equipArmor,
  collectDroppedFood,
  craftBread,
  farmWheat,
  huntAnimals,
  collectFood,
  collectNearbyResources,
  findPriorityOre,
  minePriorityOre,
  isInventoryFull,
  mineBlockObject,
  mineBlockByName,
  mineAnyByNames,
  mineIron,
  cutWood,
  mineArea,
  survivalTick
};