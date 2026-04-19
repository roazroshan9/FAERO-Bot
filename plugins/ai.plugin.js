'use strict';

/**
 * AI Plugin — wraps the Brain + DecisionEngine as a loadable FAERO plugin.
 *
 * When disabled: the AI brain is stopped and will not auto-start on spawn.
 * When enabled:  the brain auto-starts if the bot is already spawned.
 *
 * ToS note: All decision logic uses standard Mineflayer API calls only.
 * No packet manipulation. Personal, non-commercial use only.
 */

module.exports = {
  name:        'ai',
  version:     '1.0.0',
  description: 'AI decision-making engine (Brain + DecisionEngine)',
  enabled:     true,

  load(manager) {
    // If the bot is already online and AI mode is active, (re)start the brain
    if (manager && manager.aiModeEnabled && manager.bot && manager.bot.entity) {
      manager.startBrain();
    }
  },

  unload(manager) {
    // Cleanly stop the brain; AI mode flag stays so it re-activates on re-enable
    if (manager) {
      manager.stopBrain();
    }
  }
};
