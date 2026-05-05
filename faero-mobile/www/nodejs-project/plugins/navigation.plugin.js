'use strict';

/**
 * Navigation Plugin — wraps pathfinding functionality as a loadable FAERO plugin.
 *
 * When disabled: pathfinder goal is cleared and movement commands are blocked.
 * When enabled:  pathfinding is available for all movement commands.
 *
 * ToS note: Uses mineflayer-pathfinder with safe movement settings only.
 * No teleport exploits, wall-clipping, or movement packet manipulation.
 * Personal, non-commercial use only.
 */

const pathfinding = require('../modules/pathfinding');

module.exports = {
  name:        'navigation',
  version:     '1.0.0',
  description: 'Pathfinding, follow-player, and coordinate navigation',
  enabled:     true,

  load(manager) {
    if (manager) {
      manager.log('[plugin:navigation] Navigation plugin enabled');
    }
  },

  unload(manager) {
    if (manager && manager.bot) {
      try {
        pathfinding.stop(manager.bot);
      } catch (_) {}
    }
    if (manager) {
      manager.log('[plugin:navigation] Navigation plugin disabled — movement halted');
    }
  },

  // Expose core helpers for internal use
  goToCoords:      pathfinding.goToCoords,
  followPlayer:    pathfinding.followPlayer,
  stop:            pathfinding.stop,
  nearestBlock:    pathfinding.nearestBlock,
  setupMovements:  pathfinding.setupMovements
};
