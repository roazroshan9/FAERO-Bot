const commands = require('../modules/commands');

function attachSocket(io, botManager) {
  attachMinecraftChatBridge(io, botManager);

  io.on('connection', (socket) => {
    socket.emit('status', botManager.getStatus());
    socket.emit('thought', buildThoughtPayload(botManager, null));
    socket.emit('inventory', botManager.getInventory());
    if (botManager.keepAlive) {
      socket.emit('keepalive', botManager.keepAlive.getStats());
    }
    socket.on('start', async (options) => {
      try {
        const connection = normalizeConnectionOptions(options);
        botManager.log('Connecting with web values: ' + connection.host + ':' + connection.port + ' as ' + connection.username + (connection.proxy ? ' via proxy' : ''));
        await botManager.createBot(connection);
        attachMinecraftChatBridge(io, botManager);
        socket.emit('status', botManager.getStatus());
      } catch (err) {
        socket.emit('errorMessage', err.message);
      }
    });

    socket.on('stop', () => {
      botManager.stop();
      socket.emit('status', botManager.getStatus());
      socket.emit('thought', buildThoughtPayload(botManager, null));
    });

    socket.on('command', (payload) => {
      try {
        payload = payload || {};
        botManager.runWebCommand(payload.command, payload.args || {});
        socket.emit('status', botManager.getStatus());
      } catch (err) {
        socket.emit('errorMessage', err.message);
      }
    });

    socket.on('move', (payload) => {
      try {
        payload = payload || {};
        handleMove(botManager, payload.direction);
      } catch (err) {
        socket.emit('errorMessage', err.message);
      }
    });

    socket.on('chatMessage', (payload) => {
      try {
        const chat = parseChatPayload(payload, botManager);
        if (!chat.message) throw new Error('Chat message cannot be empty');
        if (!isAuthorizedChatUser(chat.username, botManager)) throw new Error('Unauthorized chat user');
        if (!botManager.bot || !botManager.bot.entity) throw new Error('Bot is not running or has not spawned yet');
        socket.emit('chatLog', { username: chat.username, message: chat.message });
        const handled = commands.handleCommand(botManager.getContext(), chat.username, chat.message);
        if (handled) io.emit('chatLog', { username: 'bot', message: 'executing command: ' + chat.message });
        botManager.bot.chat(chat.message);
      } catch (err) {
        socket.emit('errorMessage', err.message);
        socket.emit('chatLog', { username: 'bot', message: err.message });
      }
    });

    socket.on('force_cleanup', () => {
      botManager._runCleanup();
      socket.emit('log', { at: new Date().toISOString(), message: '[cleanup] Force cleanup triggered from dashboard' });
    });

    socket.on('set_ai_goal', (payload) => {
      try {
        const goalPlanner = require('../ai/goalPlanner');
        payload = payload || {};
        if (payload.stop || !payload.goal) {
          const ctx = botManager.getContext && botManager.getContext();
          if (ctx) goalPlanner.clearGoal(ctx);
          return;
        }
        const ctx = botManager.getContext && botManager.getContext();
        if (!ctx || !ctx.bot || !ctx.bot.entity) {
          socket.emit('errorMessage', 'Bot is offline — connect the bot first');
          return;
        }
        goalPlanner.setGoal(ctx, String(payload.goal).trim(), (msg) => {
          try { ctx.bot.chat('[FAERO]: ' + msg); } catch (_) {}
        });
      } catch (err) {
        socket.emit('errorMessage', err.message);
      }
    });

    socket.on('set_ai_chat', (payload) => {
      const enabled = Boolean(payload && payload.enabled);
      botManager.llmChatEnabled = enabled;
      io.emit('ai_chat_state', { llmChatEnabled: enabled });
    });

    socket.on('set_ai_mode', (payload) => {
      const enabled = Boolean(payload && payload.enabled);
      botManager.setAiMode(enabled);
      io.emit('status', botManager.getStatus());
    });

    socket.on('set_low_power_mode', (payload) => {
      const enabled = Boolean(payload && payload.enabled);
      botManager.setLowPowerMode(enabled);
      io.emit('status', botManager.getStatus());
    });

    socket.on('bot_action', (data) => {
      try {
        const bot = botManager.bot;
        if (!bot || !bot.entity) throw new Error('Bot is not running or has not spawned yet');
        const target = bot.nearestEntity((entity) => {
          return (entity.type === 'player' || entity.type === 'mob') && entity.position.distanceTo(bot.entity.position) < 4;
        });
        if (data && data.action === 'left_click') {
          if (target) bot.attack(target);
          else bot.swingArm();
        } else if (data && data.action === 'right_click') {
          if (target) bot.activateEntity(target);
          else {
            const block = bot.blockAtCursor(4);
            if (block) bot.activateBlock(block);
          }
        } else {
          throw new Error('Invalid bot action');
        }
      } catch (err) {
        socket.emit('errorMessage', err.message);
      }
    });
  });

  botManager.on('ai_goal_update', (data)  => io.emit('ai_goal_update',  data));
  botManager.on('ai_chat_reply',  (data)  => io.emit('ai_chat_reply',   data));
  botManager.on('log', (entry) => io.emit('log', entry));
  botManager.on('bot', (status) => {
    io.emit('status', status);
    io.emit('inventory', botManager.getInventory());
  });
  botManager.on('inventory', (data) => io.emit('inventory', data));
  botManager.on('state', () => {
    io.emit('status', botManager.getStatus());
    io.emit('thought', buildThoughtPayload(botManager, null));
  });
  botManager.on('queue', () => io.emit('status', botManager.getStatus()));
  botManager.on('botError', (err) => io.emit('errorMessage', err && err.message ? err.message : String(err)));
  botManager.on('thought', (payload) => io.emit('thought', buildThoughtPayload(botManager, payload)));
  botManager.on('keepalive', (stats) => io.emit('keepalive', stats));
}

function normalizeConnectionOptions(options) {
  const input = options || {};
  const host = String(input.host || process.env.MC_HOST || 'localhost').trim();
  const username = String(input.username || process.env.MC_USERNAME || 'AI_Bot').trim();
  const auth = String(input.auth || process.env.MC_AUTH || 'offline').trim();
  const version = input.version ? String(input.version).trim() : undefined;
  const port = Number(input.port || process.env.MC_PORT || 25565);
  if (!host) throw new Error('Host is required');
  if (!username) throw new Error('Username is required');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid port');
  const connection = { host, port, username, auth };
  if (version) connection.version = version;
  const proxy = input.proxy ? String(input.proxy).trim() : '';
  if (proxy) connection.proxy = proxy;
  return connection;
}

function attachMinecraftChatBridge(io, botManager) {
  const bot = botManager.bot;
  if (!bot || bot._webChatBridgeAttached) return;
  bot._webChatBridgeAttached = true;
  bot.on('chat', (username, message) => {
    io.emit('chatLog', { username, message });
  });
}

function handleMove(botManager, direction) {
  const bot = botManager.bot;
  if (!bot || !bot.entity) throw new Error('Bot is not running or has not spawned yet');
  const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
  if (direction === 'stop') {
    controls.forEach((control) => bot.setControlState(control, false));
    return;
  }
  if (!['forward', 'back', 'left', 'right', 'jump'].includes(direction)) throw new Error('Invalid movement direction');
  if (direction !== 'jump') {
    ['forward', 'back', 'left', 'right'].forEach((control) => {
      bot.setControlState(control, control === direction);
    });
  }
  bot.setControlState(direction, true);
}

function parseChatPayload(payload) {
  const authorizedUser = process.env.AUTHORIZED_USER || 'roaz';
  if (typeof payload === 'string') {
    return { username: authorizedUser, message: payload.trim() };
  }
  const input = payload || {};
  return {
    username: String(input.username || authorizedUser).trim(),
    message: String(input.message || '').trim()
  };
}

function isAuthorizedChatUser(username, botManager) {
  const authorizedUser = process.env.AUTHORIZED_USER || 'roaz';
  return username === authorizedUser || botManager.memory.isTrusted(username);
}

function buildThoughtPayload(botManager, payload) {
  const status = botManager.getStatus();
  const decision = payload && payload.decision ? sanitizeDecision(payload.decision) : {
    type: status.state.state,
    reason: status.state.reason || 'waiting'
  };
  return {
    decision,
    snapshot: payload && payload.snapshot ? sanitizeSnapshot(payload.snapshot) : {
      health: status.health,
      hunger: status.hunger,
      position: status.position,
      queue: status.queue
    }
  };
}

function sanitizeDecision(decision) {
  return {
    type: decision.type,
    reason: decision.reason,
    target: decision.target ? {
      name: decision.target.name,
      type: decision.target.type
    } : undefined,
    ore: decision.ore ? {
      name: decision.ore.name,
      position: decision.ore.position ? {
        x: Math.round(decision.ore.position.x * 10) / 10,
        y: Math.round(decision.ore.position.y * 10) / 10,
        z: Math.round(decision.ore.position.z * 10) / 10
      } : null
    } : undefined
  };
}

function sanitizeSnapshot(snapshot) {
  return {
    health: snapshot.health,
    hunger: snapshot.hunger,
    position: snapshot.position ? {
      x: Math.round(snapshot.position.x * 10) / 10,
      y: Math.round(snapshot.position.y * 10) / 10,
      z: Math.round(snapshot.position.z * 10) / 10
    } : null,
    inventory: snapshot.inventory,
    foodStock: snapshot.foodStock,
    nearbyPlayers: snapshot.nearbyPlayers,
    nearbyMobs: snapshot.nearbyMobs,
    hostileMob: snapshot.hostileMob ? {
      name: snapshot.hostileMob.name,
      type: snapshot.hostileMob.type
    } : null
  };
}

module.exports = attachSocket;
