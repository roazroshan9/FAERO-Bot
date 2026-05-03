/**
 * FAERO — Auto-Register / Auto-Login
 *
 * Reactively listens to every Minecraft message (including pre-spawn system
 * chat) and responds to auth prompts automatically using MC_PASSWORD from env.
 *
 * Environment variables:
 *   MC_PASSWORD          — the password to send for /login and /register
 *   MC_CONFIRM_PASSWORD  — optional separate confirm password for /register
 *                          (defaults to MC_PASSWORD if not set)
 *
 * Supported auth plugins (tested patterns):
 *   AuthMe Reloaded, NLogin, CMI Auth, FastLogin prompts,
 *   xAuth, Nickolas-style servers, and generic prompt phrasings.
 *
 * Uses the mineflayer `messagestr` event which fires for ALL server messages
 * — both system chat and player chat — including messages received before
 * the bot's spawn event has fired. This is essential because many auth
 * servers prompt for login/register in the pre-spawn limbo phase.
 */

'use strict';

// ── Pattern banks ─────────────────────────────────────────────────────────────

/**
 * These patterns match messages that ask the bot to /register.
 * A message only needs to match ONE pattern to trigger registration.
 */
const REGISTER_PATTERNS = [
  // AuthMe / NLogin style
  /please\s+register\s+using/i,
  /please\s+use\s+\/register/i,
  /you\s+(?:have\s+to|must|need\s+to)\s+register/i,
  /not\s+(?:yet\s+)?registered/i,
  /\/register\s+<password>/i,
  /type\s+\/register/i,
  /use\s+the\s+command\s+\/reg/i,
  /register\s+to\s+(?:play|continue|join)/i,
  /this\s+account\s+is\s+not\s+registered/i,
  /account\s+hasn'?t\s+been\s+registered/i,
  /\bregister\b.{0,60}\/register\b/i,
];

/**
 * These patterns match messages that ask the bot to /login.
 * Servers send this when the account exists but the session is not
 * authenticated yet.
 */
const LOGIN_PATTERNS = [
  // AuthMe / NLogin style
  /please\s+log\s*in\s+using/i,
  /please\s+use\s+\/login/i,
  /you\s+(?:have\s+to|must|need\s+to)\s+log\s*in/i,
  /type\s+\/login/i,
  /\/login\s+<password>/i,
  /use\s+the\s+command\s+\/log/i,
  /identify\s+yourself/i,
  /already\s+registered.*\/login/i,
  /login\s+to\s+(?:continue|play|join)/i,
  /\blogin\b.{0,60}\/login\b/i,
  /please\s+authenticate/i,
];

// ── Internal helpers ──────────────────────────────────────────────────────────

function matchesAny(patterns, text) {
  return patterns.some((p) => p.test(text));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attach the auto-auth listener to `bot`.
 *
 * Call this inside bindBotEvents (NOT inside the spawn handler) so it
 * captures messages that arrive before the spawn event fires.
 *
 * @param {object} bot       — mineflayer Bot instance
 * @param {string} password  — value of process.env.MC_PASSWORD
 * @param {Function} logFn   — botManager.log bound function
 * @returns {{ detach: Function }} — call detach() to remove the listener
 */
function attachAutoAuth(bot, password, logFn) {
  const log = logFn || (() => {});

  if (!password) {
    log('[autoauth] MC_PASSWORD not set — auto-auth disabled');
    return { detach: () => {} };
  }

  const confirmPassword = process.env.MC_CONFIRM_PASSWORD || password;

  // Session-scoped state (resets each time this function is called,
  // i.e. each time the bot reconnects and bindBotEvents runs).
  let lastAuthAt    = 0;
  let hasRegistered = false;
  let hasLoggedIn   = false;

  const AUTH_COOLDOWN_MS = 8000;

  function tryAuth(rawText) {
    const now  = Date.now();
    const text = String(rawText || '').replace(/\u00a7./g, '');  // strip MC colour codes

    // Stop if we've already logged in this session
    if (hasLoggedIn) return;

    // Debounce — ignore duplicate prompts sent within the cooldown window
    if (now - lastAuthAt < AUTH_COOLDOWN_MS) return;

    const wantsRegister = matchesAny(REGISTER_PATTERNS, text);
    const wantsLogin    = matchesAny(LOGIN_PATTERNS, text);

    if (!wantsRegister && !wantsLogin) return;

    lastAuthAt = now;

    if (wantsRegister && !hasRegistered) {
      // Register: send /register <password> <confirmPassword>
      // Most auth plugins require the password twice as a confirmation.
      bot.chat('/register ' + password + ' ' + confirmPassword);
      hasRegistered = true;
      log('[autoauth] Sent /register — detected server registration prompt');
      // After registering, the server will immediately ask to /login.
      // Set a short cooldown window so the follow-up login prompt is handled.
      lastAuthAt = now - (AUTH_COOLDOWN_MS - 3000);
    } else if (wantsLogin || hasRegistered) {
      bot.chat('/login ' + password);
      hasLoggedIn = true;
      log('[autoauth] Sent /login — detected server login prompt');
    }
  }

  // `messagestr` fires for ALL messages (system + player chat) in mineflayer 4.x.
  // Signature: (message: string, position: string, originalMsg, sender?)
  const onMessageStr = (msgStr) => {
    try { tryAuth(msgStr); } catch (_) {}
  };

  // Also catch player-routed auth prompts (some servers send via a plugin bot)
  const onChat = (username, message) => {
    if (username === bot.username) return;
    try { tryAuth(message); } catch (_) {}
  };

  bot.on('messagestr', onMessageStr);
  bot.on('chat',       onChat);

  log('[autoauth] Reactive auto-auth enabled (password configured)');

  return {
    detach() {
      bot.off('messagestr', onMessageStr);
      bot.off('chat',       onChat);
    }
  };
}

module.exports = { attachAutoAuth };
