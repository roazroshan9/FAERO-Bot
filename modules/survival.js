const { goals } = require('mineflayer-pathfinder');
const pathfinding = require('./pathfinding');
const inventory = require('./inventory');
const combat = require('./combat');

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

async function mineBlockByName(bot, blockName, maxCount) {
  let mined = 0;
  const limit = Math.min(Number(maxCount) || 16, 16);
  while (mined < limit) {
    const block = pathfinding.nearestBlock(bot, [blockName], 24);
    if (!block) break;
    const ok = await mineBlockObject(bot, block);
    if (!ok) break;
    mined++;
    await wait(100);
  }
  return mined;
}

async function mineIron(bot) {
  return mineAnyByNames(bot, ['iron_ore', 'deepslate_iron_ore'], 32);
}

async function cutWood(bot) {
  let count = 0;
  for (const name of ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log']) {
    count += await mineBlockByName(bot, name, 16);
    if (count >= 16) break;
  }
  return count;
}

async function mineAnyByNames(bot, names, maxCount) {
  let mined = 0;
  const limit = Math.min(Number(maxCount) || 16, 16);
  while (mined < limit) {
    let block = null;
    for (const name of names) {
      block = pathfinding.nearestBlock(bot, [name], 24);
      if (block) break;
    }
    if (!block) break;
    const ok = await mineBlockObject(bot, block);
    if (!ok) break;
    mined++;
    await wait(100);
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
  mineBlockObject,
  mineBlockByName,
  mineAnyByNames,
  mineIron,
  cutWood,
  mineArea,
  survivalTick
};