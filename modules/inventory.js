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

const MAIN_INVENTORY_SLOTS = 36; // hotbar (9) + main (27), excludes armor/offhand
const SORT_CAPACITY_PCT    = 0.9;

/** True when at least 90% of main inventory slots are occupied. */
function isInventoryNearFull(bot) {
  const items = bot.inventory.items();
  return (items.length / MAIN_INVENTORY_SLOTS) >= SORT_CAPACITY_PCT;
}

/**
 * Discard junk items to free up space when inventory is near capacity.
 * Returns { dropped, kept, triggered } so the caller can report results.
 */
async function sortInventory(bot, opts) {
  const force = opts && opts.force;
  if (!force && !isInventoryNearFull(bot)) {
    return { triggered: false, dropped: 0, kept: 0, reason: 'below_threshold' };
  }
  let dropped = 0;
  for (const item of bot.inventory.items()) {
    if (!USELESS_ITEMS.includes(item.name)) continue;
    try { await bot.tossStack(item); dropped += item.count; } catch (_) {}
  }
  return {
    triggered: true,
    dropped,
    kept: bot.inventory.items().length,
    capacityPct: Math.round((bot.inventory.items().length / MAIN_INVENTORY_SLOTS) * 100)
  };
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
  sortInventory,
  isInventoryNearFull,
  hasFood,
  USELESS_ITEMS,
  MAIN_INVENTORY_SLOTS,
  SORT_CAPACITY_PCT
};