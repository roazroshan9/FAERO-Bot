const fs = require('fs');
const path = require('path');

class Memory {
  constructor(filePath) {
    this.filePath = filePath || path.join(process.cwd(), '.minecraft-bot-memory.json');
    this.lastCleanup = 0;
    this.cleanupIntervalMs = readPositiveInt(process.env.MEMORY_CLEANUP_INTERVAL_MS, 60000);
    this.limits = {
      maxTrustedPlayers: readPositiveInt(process.env.MEMORY_MAX_TRUSTED_PLAYERS, 50),
      maxEnemies: readPositiveInt(process.env.MEMORY_MAX_ENEMIES, 50),
      maxAttackedBy: readPositiveInt(process.env.MEMORY_MAX_ATTACKERS, 50),
      maxPayments: readPositiveInt(process.env.MEMORY_MAX_PAYMENTS, 50),
      maxFacts: readPositiveInt(process.env.MEMORY_MAX_FACTS, 50),
      attackedByTtlMs: readPositiveInt(process.env.MEMORY_ATTACKED_BY_TTL_MS, 600000),
      paymentsTtlMs: readPositiveInt(process.env.MEMORY_PAYMENTS_TTL_MS, 3600000),
      factsTtlMs: readPositiveInt(process.env.MEMORY_FACTS_TTL_MS, 86400000),
      maxStringLength: readPositiveInt(process.env.MEMORY_MAX_STRING_LENGTH, 160)
    };
    this.data = {
      lastAction: null,
      trustedPlayers: ['roaz'],
      enemies: [],
      attackedBy: {},
      payments: {},
      facts: {}
    };
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.save();
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.data = Object.assign(this.data, parsed);
      this.normalize();
      const changed = this.cleanup(true);
      if (changed) this.save();
    } catch (err) {
      this.save();
    }
  }

  save() {
    this.cleanup(false);
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  setLastAction(action) {
    this.data.lastAction = {
      action: sanitizeString(action, this.limits.maxStringLength),
      at: Date.now()
    };
    this.save();
  }

  trustPlayer(username) {
    if (!username) return;
    if (!this.data.trustedPlayers.includes(username)) {
      this.data.trustedPlayers.push(username);
    }
    this.removeEnemy(username);
    this.save();
  }

  untrustPlayer(username) {
    this.data.trustedPlayers = this.data.trustedPlayers.filter((name) => name !== username);
    this.save();
  }

  isTrusted(username) {
    return this.data.trustedPlayers.includes(username);
  }

  addEnemy(username) {
    if (!username || this.isTrusted(username)) return;
    if (!this.data.enemies.includes(username)) {
      this.data.enemies.push(username);
    }
    this.save();
  }

  removeEnemy(username) {
    this.data.enemies = this.data.enemies.filter((name) => name !== username);
    this.save();
  }

  isEnemy(username) {
    return this.data.enemies.includes(username);
  }

  markAttackedBy(username) {
    if (!username || this.isTrusted(username)) return;
    this.data.attackedBy[sanitizeString(username, this.limits.maxStringLength)] = Date.now();
    this.save();
  }

  recentlyAttackedBy(username, windowMs) {
    const at = this.data.attackedBy[username];
    return Boolean(at && Date.now() - at < (windowMs || 120000));
  }

  canPay(key, cooldownMs) {
    this.cleanup(false);
    const last = this.data.payments[key] || 0;
    return Date.now() - last >= cooldownMs;
  }

  markPaid(key) {
    this.data.payments[sanitizeString(key, this.limits.maxStringLength)] = Date.now();
    this.save();
  }

  snapshot() {
    this.cleanup(false);
    return {
      lastAction: this.data.lastAction,
      trustedPlayers: this.data.trustedPlayers.slice(0, this.limits.maxTrustedPlayers),
      enemies: this.data.enemies.slice(0, this.limits.maxEnemies),
      attackedBy: copyNewestEntries(this.data.attackedBy, this.limits.maxAttackedBy),
      payments: copyNewestEntries(this.data.payments, this.limits.maxPayments),
      facts: copyNewestEntries(this.data.facts, this.limits.maxFacts)
    };
  }

  normalize() {
    this.data.trustedPlayers = normalizeStringList(this.data.trustedPlayers, this.limits.maxTrustedPlayers, this.limits.maxStringLength, ['roaz']);
    this.data.enemies = normalizeStringList(this.data.enemies, this.limits.maxEnemies, this.limits.maxStringLength);
    this.data.attackedBy = normalizeTimestampMap(this.data.attackedBy, this.limits.maxAttackedBy, this.limits.maxStringLength);
    this.data.payments = normalizeTimestampMap(this.data.payments, this.limits.maxPayments, this.limits.maxStringLength);
    this.data.facts = normalizeFactMap(this.data.facts, this.limits.maxFacts, this.limits.maxStringLength);
    if (this.data.lastAction && typeof this.data.lastAction === 'object') {
      this.data.lastAction = {
        action: sanitizeString(this.data.lastAction.action, this.limits.maxStringLength),
        at: Number(this.data.lastAction.at) || Date.now()
      };
    } else {
      this.data.lastAction = null;
    }
  }

  cleanup(force) {
    const now = Date.now();
    if (!force && now - this.lastCleanup < this.cleanupIntervalMs) return false;
    this.lastCleanup = now;
    const before = JSON.stringify(this.data);
    this.normalize();
    this.data.attackedBy = pruneTimestampMap(this.data.attackedBy, this.limits.attackedByTtlMs, this.limits.maxAttackedBy, now);
    this.data.payments = pruneTimestampMap(this.data.payments, this.limits.paymentsTtlMs, this.limits.maxPayments, now);
    this.data.facts = pruneFactMap(this.data.facts, this.limits.factsTtlMs, this.limits.maxFacts, now);
    return before !== JSON.stringify(this.data);
  }
}

function normalizeStringList(value, maxItems, maxLength, defaults) {
  const initial = Array.isArray(value) ? value : [];
  const merged = (defaults || []).concat(initial);
  return Array.from(new Set(merged.map((item) => sanitizeString(item, maxLength)).filter(Boolean))).slice(-maxItems);
}

function normalizeTimestampMap(value, maxItems, maxLength) {
  const source = value && typeof value === 'object' ? value : {};
  const output = {};
  Object.entries(source).forEach(([key, at]) => {
    const safeKey = sanitizeString(key, maxLength);
    const safeAt = Number(at);
    if (safeKey && Number.isFinite(safeAt)) output[safeKey] = safeAt;
  });
  return copyNewestEntries(output, maxItems);
}

function normalizeFactMap(value, maxItems, maxLength) {
  const source = value && typeof value === 'object' ? value : {};
  const output = {};
  Object.entries(source).forEach(([key, fact]) => {
    const safeKey = sanitizeString(key, maxLength);
    if (!safeKey) return;
    if (fact && typeof fact === 'object' && Number.isFinite(Number(fact.at))) {
      output[safeKey] = {
        value: sanitizeFactValue(fact.value, maxLength),
        at: Number(fact.at)
      };
    } else {
      output[safeKey] = {
        value: sanitizeFactValue(fact, maxLength),
        at: Date.now()
      };
    }
  });
  return copyNewestEntries(output, maxItems);
}

function pruneTimestampMap(map, ttlMs, maxItems, now) {
  const fresh = {};
  Object.entries(map || {}).forEach(([key, at]) => {
    if (now - Number(at) <= ttlMs) fresh[key] = Number(at);
  });
  return copyNewestEntries(fresh, maxItems);
}

function pruneFactMap(map, ttlMs, maxItems, now) {
  const fresh = {};
  Object.entries(map || {}).forEach(([key, fact]) => {
    const at = fact && Number(fact.at);
    if (Number.isFinite(at) && now - at <= ttlMs) fresh[key] = fact;
  });
  return copyNewestEntries(fresh, maxItems);
}

function copyNewestEntries(map, maxItems) {
  const output = {};
  Object.entries(map || {})
    .sort((a, b) => getEntryTime(a[1]) - getEntryTime(b[1]))
    .slice(-maxItems)
    .forEach(([key, value]) => {
      output[key] = value;
    });
  return output;
}

function getEntryTime(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  if (value && Number.isFinite(Number(value.at))) return Number(value.at);
  return 0;
}

function sanitizeString(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function sanitizeFactValue(value, maxLength) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return sanitizeString(value, maxLength);
  }
  try {
    return sanitizeString(JSON.stringify(value), maxLength);
  } catch (err) {
    return '';
  }
}

function readPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

module.exports = Memory;