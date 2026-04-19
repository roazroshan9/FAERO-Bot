# FAERO — AI Minecraft Bot

**Personal automation assistant for Minecraft, built with Mineflayer.**

> **Usage notice:** FAERO is for personal, non-commercial use only.
> It performs no packet manipulation, no unauthorized network scanning, and no
> activity that violates [Replit's Terms of Service](https://replit.com/site/terms)
> or standard Minecraft server policies. All gameplay actions use the public
> [Mineflayer API](https://github.com/PrismarineJS/mineflayer) exclusively.

---

## Features

| Feature | Details |
|---|---|
| 🤖 AI Brain | Autonomous survival loop (health, hunger, resources, combat) |
| 🛡 Guardian Mode | Protects the owner from nearby hostile mobs |
| ⚔️ Combat | PvP and mob engagement via mineflayer-pvp |
| ⛏ Mining | Smart ore priority, area mining, wood collection |
| 🌐 Web Panel | Cyberpunk-themed real-time control dashboard (Socket.IO) |
| 🎮 Discord Bridge | Full remote control with RBAC access tiers |
| 🧩 Plugin System | AI, Combat, Navigation load/unload at runtime |
| 📊 Self-Monitoring | Heap + CPU tracking; auto-disconnect on memory limit |
| 🔒 RBAC | Owner / Moderator / None tiers for Discord and in-game |

---

## Architecture

```
FAERO/
├── app.js                  # Main entry point
├── core/
│   ├── botManager.js       # Bot lifecycle, plugin orchestration
│   ├── pluginLoader.js     # Modular plugin registry
│   ├── monitor.js          # Heap + CPU self-monitoring
│   ├── taskQueue.js        # Priority task queue
│   ├── stateManager.js     # FSM state tracker
│   └── memory.js           # Persistent player memory
├── plugins/                # Loadable plugin modules
│   ├── ai.plugin.js        # AI Brain + DecisionEngine
│   ├── combat.plugin.js    # Guardian Mode, PvP, mob detection
│   └── navigation.plugin.js# Pathfinding, follow, coordinate nav
├── ai/
│   ├── brain.js            # Tick loop orchestrator
│   └── decisionEngine.js   # Survival/combat/resource decisions
├── modules/
│   ├── commands.js         # In-game NLP command parser
│   ├── combat.js           # Attack / stop-combat helpers
│   ├── pathfinding.js      # Safe movement primitives
│   ├── survival.js         # Food, ore, crafting routines
│   ├── inventory.js        # Inventory inspection & tool equip
│   └── economy.js          # /pay and /bal wrappers
├── discord/
│   └── client.js           # Discord bridge with RBAC + rate limits
├── web/
│   ├── server.js           # Express + Socket.IO server
│   ├── socket.js           # Real-time event bridge
│   └── public/             # Dashboard frontend
└── config/
    └── roles.js            # RBAC permission map
```

---

## Setup

### 1 — Replit Secrets (required)

Add these in **Replit → Secrets**:

| Secret | Description |
|---|---|
| `MC_HOST` | Minecraft server hostname or IP |
| `MC_PORT` | Server port (default `25565`) |
| `MC_USERNAME` | Bot's Minecraft username |
| `MC_AUTH` | `offline` or `microsoft` |
| `AUTHORIZED_USER` | Your Minecraft username (owner) |
| `OWNER_DISCORD_ID` | Your 18-digit Discord user ID |
| `DISCORD_TOKEN` | Discord bot token (optional) |
| `MC_PASSWORD` | Auth server password (optional) |
| `DISCORD_LOG_CHANNEL_ID` | Channel for live log forwarding (optional) |

### 2 — Optional tuning

| Variable | Default | Description |
|---|---|---|
| `SAFE_HEAP_MB` | `400` | Heap limit before auto-disconnect |
| `MONITOR_INTERVAL_MS` | `30000` | Resource check frequency |
| `COMMAND_COOLDOWN_MS` | `2000` | Min ms between in-game commands |
| `DISCORD_RATE_LIMIT_MS` | `3000` | Per-user Discord cooldown |
| `DISCORD_GLOBAL_MAX_CMDS` | `30` | Global command budget per window |
| `DISCORD_GLOBAL_WINDOW_MS` | `60000` | Global rate-limit window (ms) |
| `MAX_ACTIONS_PER_WINDOW` | `15` | Max bot actions per 10 s window |
| `PVP_ENABLED` | `false` | Allow attacking enemy players |
| `AUTO_START_BOT` | `false` | Connect automatically on startup |

---

## Plugin System

Plugins are auto-discovered from `plugins/*.plugin.js` at startup.
Each plugin exports a standard interface:

```js
module.exports = {
  name: 'my-plugin',       // unique ID
  version: '1.0.0',
  description: 'What it does',
  enabled: true,           // default state
  load(manager) { ... },   // called on enable
  unload(manager) { ... }  // called on disable
};
```

### Managing plugins via Discord

```
!bot plugins                    → list all plugins and their state
!bot plugin enable navigation   → enable navigation at runtime
!bot plugin disable combat      → disable combat (stops guardian + pvp)
!bot plugin disable ai          → stop the AI brain
```

### Built-in plugins

| Plugin | Controls |
|---|---|
| `ai` | Brain tick loop, autonomous decision engine |
| `combat` | Guardian Mode, danger watch, PvP engagement |
| `navigation` | Pathfinder, follow, coordinate movement |

---

## Discord Commands

**Prefix:** `!bot <command>`

| Command | Role | Description |
|---|---|---|
| `help` | MOD | List commands for your role |
| `status` | MOD | Full bot status embed |
| `health` | MOD | HP and hunger |
| `logs [n]` | MOD | Last n log entries |
| `resources` | OWNER | Heap / CPU / uptime report |
| `connect` | OWNER | Connect to Minecraft server |
| `disconnect` | OWNER | Disconnect bot |
| `follow` | OWNER | Follow authorized player |
| `stop` | OWNER | Halt current task |
| `go <x> <y> <z>` | OWNER | Navigate to coordinates |
| `ai on/off` | OWNER | Toggle AI brain |
| `plugins` | OWNER | List plugins and status |
| `plugin enable/disable <name>` | OWNER | Toggle plugin at runtime |
| `roles` | OWNER | View RBAC config |
| `add-mod <id>` | OWNER | Add Discord moderator |
| `remove-mod <id>` | OWNER | Remove Discord moderator |
| `add-mcmod <name>` | OWNER | Add in-game moderator |
| `remove-mcmod <name>` | OWNER | Remove in-game moderator |
| `reload` | OWNER | Reload roles from file |

---

## In-Game Commands

**Prefix:** `!` — only recognized from RBAC-approved usernames.

| Command | Role | Description |
|---|---|---|
| `!help` | MOD | List available commands |
| `!status` | MOD | Position, HP, hunger, state |
| `!follow` | MOD | Follow you at 2-block range |
| `!come` | MOD | Navigate to your position |
| `!stop` | OWNER | Halt all tasks |
| `!protect` | OWNER | Activate Guardian Mode |
| `!attack <target>` | OWNER | Attack a player/mob |
| `!mine <block>` | OWNER | Mine nearest block of type |
| `!go <x> <y> <z>` | OWNER | Navigate to coordinates |
| `!eat` | OWNER | Eat food from inventory |
| `!food` | OWNER | Collect food from environment |
| `!jump` | OWNER | Jump once |
| `!look` | OWNER | Scan surroundings |
| `!bal` | OWNER | Request balance (`/bal`) |
| `!pay <player> <amt>` | OWNER | Pay a player |

---

## Self-Monitoring

FAERO monitors its own resource usage every `MONITOR_INTERVAL_MS` milliseconds:

- **Heap memory**: if usage exceeds `SAFE_HEAP_MB`, the bot auto-disconnects and
  sends a Discord alert to `DISCORD_LOG_CHANNEL_ID`.
- **CPU**: sampled via `process.cpuUsage()` and reported in the `!bot resources` embed.
- **Action rate gate**: the monitor enforces a maximum of `MAX_ACTIONS_PER_WINDOW`
  bot actions per 10-second window, helping avoid server-side anti-cheat flags.

---

## Rate Limiting

Three independent rate-limit layers protect against spam:

| Layer | Setting | Default | Scope |
|---|---|---|---|
| In-game cooldown | `COMMAND_COOLDOWN_MS` | 2 s | Global, all players |
| Discord per-user | `DISCORD_RATE_LIMIT_MS` | 3 s | Per Discord user ID |
| Discord global | `DISCORD_GLOBAL_MAX_CMDS` / `DISCORD_GLOBAL_WINDOW_MS` | 30 / 60 s | All Discord users |
| Bot action gate | `MAX_ACTIONS_PER_WINDOW` | 15 / 10 s | Bot-side action bursts |

---

## ToS & Ethics

- All gameplay actions use the standard [Mineflayer](https://github.com/PrismarineJS/mineflayer) API.
- No packet injection, no hit-registration manipulation, no wall-clipping exploits.
- No scraping, scanning, or unauthorized access to external networks.
- Intended for personal use on servers where the owner has permission to run bots.
- Check the Terms of Service of any server before connecting.

---

## License

Personal use only. Not for commercial redistribution.
