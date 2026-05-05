'use strict';

/**
 * FaeroForeground — Cordova JavaScript API
 * ─────────────────────────────────────────
 * Thin wrapper around the Android FaeroForegroundPlugin / FaeroForegroundService.
 * Available as window.FaeroForeground after the Cordova deviceready event.
 *
 * Usage:
 *   FaeroForeground.start({ state:'IDLE', health:20, food:20, server:'mc.example.com' });
 *   FaeroForeground.update({ state:'MINING', health:18, food:15, dimension:'overworld' });
 *   FaeroForeground.stop();
 */

var exec = require('cordova/exec');

var SERVICE = 'FaeroForeground';

/**
 * @typedef  {Object} BotStatus
 * @property {string} [state]      - Bot state label, e.g. 'IDLE', 'MINING', 'COMBAT'
 * @property {number} [health]     - Current HP (0–20)
 * @property {number} [food]       - Current food level (0–20)
 * @property {string} [server]     - Server address shown as notification sub-text
 * @property {string} [dimension]  - Dimension: 'overworld', 'nether', 'the_end'
 */

module.exports = {

  /**
   * Start the foreground service and display the persistent notification.
   * Safe to call multiple times — subsequent calls update the notification.
   *
   * @param {BotStatus} opts
   * @param {Function}  [success]
   * @param {Function}  [error]
   */
  start: function (opts, success, error) {
    exec(
      success || function () {},
      error   || function (e) { console.warn('[FaeroForeground] start error:', e); },
      SERVICE, 'start', [opts || {}]
    );
  },

  /**
   * Update the notification text without restarting the service.
   * Call this on every bot status event to keep HP/food/state current.
   *
   * @param {BotStatus} status
   * @param {Function}  [success]
   * @param {Function}  [error]
   */
  update: function (status, success, error) {
    exec(
      success || function () {},
      error   || function (e) { console.warn('[FaeroForeground] update error:', e); },
      SERVICE, 'update', [status || {}]
    );
  },

  /**
   * Stop the foreground service and dismiss the notification.
   *
   * @param {Function} [success]
   * @param {Function} [error]
   */
  stop: function (success, error) {
    exec(
      success || function () {},
      error   || function (e) { console.warn('[FaeroForeground] stop error:', e); },
      SERVICE, 'stop', []
    );
  }

};
