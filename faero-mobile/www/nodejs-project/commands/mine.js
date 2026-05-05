module.exports = {
  name: 'mine',
  description: 'Starts mining the specified block type near the bot.',

  execute(bot, args) {
    bot.chat('Mining started!');

    // ── Placeholder ──────────────────────────────────────────────
    // Replace this section with your actual mining logic.
    //
    // Example using mineflayer-pathfinder:
    //
    //   const mcData = require('minecraft-data')(bot.version);
    //   const { goals } = require('mineflayer-pathfinder');
    //
    //   const blockName = args[0] || 'iron_ore';
    //   const blockType = mcData.blocksByName[blockName];
    //   if (!blockType) { bot.chat('Unknown block: ' + blockName); return; }
    //
    //   const block = bot.findBlock({
    //     matching: blockType.id,
    //     maxDistance: 32
    //   });
    //
    //   if (!block) { bot.chat('No ' + blockName + ' found nearby!'); return; }
    //
    //   bot.pathfinder.setGoal(
    //     new goals.GoalBlock(block.position.x, block.position.y, block.position.z)
    //   );
    //   bot.chat('Moving to ' + blockName + ' at ' + JSON.stringify(block.position));
    // ─────────────────────────────────────────────────────────────
  }
};
