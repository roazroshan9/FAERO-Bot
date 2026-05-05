'use strict';

/**
 * Combat Plugin — wraps combat functionality as a loadable FAERO plugin.
 *
 * When disabled: Guardian Mode and automatic mob engagement are halted.
 * When enabled:  Combat resumes normally; danger watch restarts if bot is online.
 *
 * ToS note: Uses only mineflayer-pvp for standard attack actions.
 * No packet injection or hit-registration manipulation.
 * Personal, non-commercial use only.
 */

const combat = require('../modules/combat');

module.exports = {
  name:        'combat',
  version:     '1.0.0',
  description: 'Guardian Mode, hostile mob detection & PvP engagement',
  enabled:     true,

  load(manager) {
    // Restart danger watch if bot is already online
    if (manager && manager.bot && manager.bot.entity) {
      manager.startDangerWatch(manager.bot);
    }
  },

  unload(manager) {
    if (!manager) return;
    // Stop active guardian timer
    if (manager._guardianTimer) {
      clearInterval(manager._guardianTimer);
      manager._guardianTimer = null;
    }
    manager._guardianActive   = false;
    manager._guardianUsername = null;
    // Stop danger watch
    manager._stopDangerWatch();
    // Cease any running PvP
    if (manager.bot) {
      combat.stopCombat(manager.bot);
    }
  },

  // Expose helpers for other modules
  isHostileMob:    combat.isHostileMob,
  nearestHostile:  combat.nearestHostileMob
};
