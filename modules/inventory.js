const USELESS_ITEMS = [
  'rotten_flesh',
  'poisonous_potato',
  'dirt',
  'cobblestone',
  'gravel',
  'flint',
  'sand'
];

function getInventorySummary(bot) {
  const items = {};
  bot.inventory.items().forEach((item) => {
    items[item.name] = (items[item.name] || 0) + item.count;
  });
  return items;
}

function countItem(bot, names) {
  const list = Array.isArray(names) ? names : [names];
  return bot.inventory.items()
    .filter((item) => list.includes(item.name))
    .reduce((sum, item) => sum + item.count, 0);
}

function findItem(bot, names) {
  const list = Array.isArray(names) ? names : [names];
  return bot.inventory.items().find((item) => list.includes(item.name));
}

async function equipBestTool(bot, block) {
  if (!bot.tool || !block) return;
  try {
    await bot.tool.equipForBlock(block);
  } catch (err) {
    return;
  }
}

async function dropUseless(bot) {
  for (const item of bot.inventory.items()) {
    if (USELESS_ITEMS.includes(item.name) && item.count > 32) {
      await bot.tossStack(item);
    }
  }
}

function hasFood(bot) {
  return Boolean(findItem(bot, [
    'bread',
    'cooked_beef',
    'cooked_porkchop',
    'cooked_chicken',
    'cooked_mutton',
    'cooked_cod',
    'cooked_salmon',
    'apple',
    'carrot',
    'potato',
    'beef',
    'porkchop',
    'chicken',
    'mutton'
  ]));
}

module.exports = {
  getInventorySummary,
  countItem,
  findItem,
  equipBestTool,
  dropUseless,
  hasFood,
  USELESS_ITEMS
};