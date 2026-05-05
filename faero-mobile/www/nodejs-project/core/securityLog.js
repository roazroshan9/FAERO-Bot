/**
 * FAERO — Security Log (core/securityLog.js)
 *
 * Append-only log of access-control events:
 *   • DENY    — authenticated user lacked permission for a specific command
 *   • UNAUTH  — unknown / NONE-tier user attempted to issue a !command
 *   • ROLE    — role grants/revocations (audit trail)
 *
 * Log file: logs/security.log
 *   - Created on first write (logs/ mkdir'd if missing)
 *   - Auto-rotated when it exceeds MAX_BYTES (default 1 MB) — old file
 *     is renamed to security.log.1 and a fresh log starts
 *   - Reads are non-throwing; writes never block the bot loop
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'security.log');
const MAX_BYTES = 1024 * 1024; // 1 MB before rotation

function ensureDir() {
  try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
}

function rotateIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const size = fs.statSync(LOG_FILE).size;
    if (size < MAX_BYTES) return;
    const backup = LOG_FILE + '.1';
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
    fs.renameSync(LOG_FILE, backup);
  } catch (_) {}
}

function append(kind, fields) {
  ensureDir();
  rotateIfNeeded();
  const ts   = new Date().toISOString();
  const data = Object.entries(fields)
    .map(([k, v]) => k + '="' + String(v).replace(/"/g, "'") + '"')
    .join(' ');
  const line = '[' + ts + '] ' + kind + ' ' + data + '\n';
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
  // Console echo so it shows up in the workflow log too
  process.stdout.write('[SECURITY] ' + kind + ' ' + data + '\n');
  return line.trim();
}

function logDeny(username, command, userTierName, requiredTierName, source) {
  return append('DENY', {
    source:    source || 'mc',
    user:      username,
    cmd:       command,
    tier:      userTierName,
    required:  requiredTierName
  });
}

function logUnauthorized(username, rawMessage, source) {
  return append('UNAUTH', {
    source: source || 'mc',
    user:   username,
    raw:    String(rawMessage).slice(0, 80)
  });
}

function logRoleChange(actor, action, target, role) {
  return append('ROLE', {
    actor,
    action,        // 'grant' | 'revoke'
    target,
    role
  });
}

function getRecent(count) {
  ensureDir();
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    const data = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = data.trim().split('\n').filter(Boolean);
    return lines.slice(-(count || 50));
  } catch (_) {
    return [];
  }
}

module.exports = {
  logDeny,
  logUnauthorized,
  logRoleChange,
  getRecent,
  LOG_FILE
};
