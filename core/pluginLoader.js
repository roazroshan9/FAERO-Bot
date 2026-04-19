'use strict';

/**
 * PluginLoader — Modular plugin registry for FAERO
 *
 * Plugin contract (each plugin must export):
 *   name        {string}   — unique identifier
 *   version     {string}   — semver string
 *   description {string}   — one-line summary
 *   load(manager)          — called when plugin is enabled at runtime
 *   unload(manager)        — called when plugin is disabled at runtime
 *
 * Plugin files live in <project-root>/plugins/*.plugin.js and are auto-discovered.
 */

const fs           = require('fs');
const path         = require('path');
const EventEmitter = require('events');

class PluginLoader extends EventEmitter {
  constructor() {
    super();
    this._plugins = new Map(); // name -> { plugin, enabled, loadedAt }
  }

  // ── Discovery ──────────────────────────────────────────────────────────────

  loadAll(pluginsDir) {
    if (!fs.existsSync(pluginsDir)) return 0;
    const files = fs.readdirSync(pluginsDir)
      .filter((f) => f.endsWith('.plugin.js'))
      .sort();
    let count = 0;
    for (const file of files) {
      try {
        const plugin = require(path.join(pluginsDir, file));
        this.register(plugin);
        count++;
      } catch (err) {
        console.error('[pluginLoader] Failed to load ' + file + ': ' + err.message);
      }
    }
    return count;
  }

  // ── Registration ───────────────────────────────────────────────────────────

  register(plugin) {
    if (!plugin || typeof plugin.name !== 'string' || !plugin.name) {
      throw new Error('Plugin must export a string `name`');
    }
    if (this._plugins.has(plugin.name)) {
      throw new Error('Duplicate plugin: ' + plugin.name);
    }
    this._plugins.set(plugin.name, {
      plugin,
      enabled: plugin.enabled !== false,
      loadedAt: plugin.enabled !== false ? Date.now() : null
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  enable(name, manager) {
    const entry = this._plugins.get(name);
    if (!entry) throw new Error('Unknown plugin: ' + name);
    if (entry.enabled) return false;
    entry.enabled  = true;
    entry.loadedAt = Date.now();
    if (typeof entry.plugin.load === 'function') {
      try { entry.plugin.load(manager); } catch (err) {
        entry.enabled = false;
        throw new Error('Plugin load() threw: ' + err.message);
      }
    }
    this.emit('enabled', name);
    if (manager && typeof manager.log === 'function') {
      manager.log('[pluginLoader] Plugin enabled: ' + name);
    }
    return true;
  }

  disable(name, manager) {
    const entry = this._plugins.get(name);
    if (!entry) throw new Error('Unknown plugin: ' + name);
    if (!entry.enabled) return false;
    entry.enabled = false;
    if (typeof entry.plugin.unload === 'function') {
      try { entry.plugin.unload(manager); } catch (err) {
        console.error('[pluginLoader] Plugin unload() error (' + name + '):', err.message);
      }
    }
    this.emit('disabled', name);
    if (manager && typeof manager.log === 'function') {
      manager.log('[pluginLoader] Plugin disabled: ' + name);
    }
    return true;
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  isEnabled(name) {
    const entry = this._plugins.get(name);
    return entry ? entry.enabled : false;
  }

  get(name) {
    const entry = this._plugins.get(name);
    return entry ? entry.plugin : null;
  }

  list() {
    const results = [];
    for (const [name, entry] of this._plugins) {
      results.push({
        name,
        version:     entry.plugin.version     || '1.0.0',
        description: entry.plugin.description || '',
        enabled:     entry.enabled,
        loadedAt:    entry.loadedAt
      });
    }
    return results;
  }
}

module.exports = PluginLoader;
