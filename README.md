# FAERO — Minecraft AI Bot

A personal Mineflayer-based Minecraft bot with a cyberpunk web control panel, Discord integration, and NLP in-game command system.

**This project is for personal, non-commercial use only.**

---

## Compliance & Ethics

### Replit Terms of Service
- No unauthorized network scanning or port sweeping.
- No DDoS or flood behavior. All outbound connections are limited to one Minecraft server at a time (the owner's own server or a server the owner has permission to use).
- Resource consumption is self-monitored: the bot disconnects automatically if heap memory exceeds a configurable safe limit (`SAFE_HEAP_MB`, default 400 MB).
- No background cryptocurrency mining, data scraping, or any other prohibited activity.

### Minecraft Server Policies
- The bot performs only standard mineflayer gameplay actions (movement, chat, mining, combat) via the official Minecraft protocol.
- No packet manipulation, exploit injection, or illegal server access.
- All bot actions are rate-limited:
  - In-game commands: 2-second cooldown between commands (`COMMAND_COOLDOWN_MS`).
  - Action rate cap: max 15 actions per 10-second window (`MAX_ACTIONS_PER_WINDOW`).
  - Discord commands: 3-second per-user cooldown (`DISCORD_RATE_LIMIT_MS`).
- Guardian mode scans for nearby mobs every 1.5 seconds — well within normal player reaction times.
- The bot must only be used on servers where the owner has explicit permission to run automated clients. Many servers prohibit bots in their rules; always check before connecting.

### AI / NLP
- All NLP (Natural Language Processing) is performed **locally** using plain JavaScript regex and keyword matching.
- No external AI APIs are called for command parsing. No user input is transmitted to third parties.
- The NLP system only maps recognized commands to legitimate gameplay actions. Unrecognized input is rejected with an error message.

---

## Features

| Feature | Description |
|---|---|
| Web panel | Neon-green cyberpunk UI on port 3000 |
| Discord bot | `!bot` prefix commands via discord.js |
| In-game NLP | `!` prefix commands with natural language variations |
| Guardian mode | Auto-attacks hostile mobs within 10 blocks of the owner |
| Auto-login | Sends `/login <MC_PASSWORD>` 2 seconds after spawn |
| Resource monitor | Alerts via Discord and disconnects if heap > safe limit |
| Rate limiting | Per-command and per-user cooldowns across all interfaces |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MC_HOST` | `localhost` | Minecraft server hostname |
| `MC_PORT` | `25565` | Minecraft server port |
| `MC_USERNAME` | `AI_Bot` | Bot username |
| `MC_AUTH` | `offline` | Auth type (`offline` or `microsoft`) |
| `MC_PASSWORD` | *(secret)* | Password for `/login` on cracked servers |
| `DISCORD_TOKEN` | *(secret)* | Discord bot token |
| `DISCORD_LOG_CHANNEL_ID` | *(optional)* | Channel ID for log forwarding & alerts |
| `DISCORD_GUILD_ID` | *(optional)* | Restrict bot to one guild |
| `DISCORD_RATE_LIMIT_MS` | `3000` | Cooldown between Discord commands per user |
| `AUTHORIZED_USER` | `roaz` | In-game username authorized to issue `!` commands |
| `COMMAND_COOLDOWN_MS` | `2000` | Minimum ms between in-game commands |
| `MAX_ACTIONS_PER_WINDOW` | `15` | Max bot actions per 10-second window |
| `SAFE_HEAP_MB` | `400` | Heap limit (MB) before auto-disconnect |
| `PVP_ENABLED` | `false` | Allow PvP attacks against players |
| `AUTO_START_BOT` | `false` | Connect to Minecraft on startup |

**Secrets** (`MC_PASSWORD`, `DISCORD_TOKEN`) must be stored in Replit Secrets, never in code or plain text files.

---

## In-Game Commands

All commands require the sender to be `AUTHORIZED_USER`. Commands must start with `!`.

| Command | Aliases | Action |
|---|---|---|
| `!help` | `!commands` | List all commands |
| `!status` | `!pos`, `!info`, `!where are you` | Full status report |
| `!follow` | `!follow me`, `!track me` | Follow you |
| `!come` | `!come here`, `!come to me` | Walk to your position |
| `!stop` | `!halt`, `!freeze`, `!abort` | Stop all tasks |
| `!go <x> <y> <z>` | `!goto`, `!navigate to`, `!move to` | Navigate to coords |
| `!protect` | `!guardian`, `!guard me` | Guardian Mode (attack nearby hostiles) |
| `!mine <block>` | `!dig <block>`, `!find <block>` | Mine a block type |
| `!mine iron` | `!iron ore` | Mine iron specifically |
| `!attack <player>` | `!kill`, `!fight` | Attack a player (PvP must be enabled) |
| `!eat` | `!consume` | Eat food from inventory |
| `!collect food` | `!get food`, `!forage` | Collect nearby food |
| `!status` | | HP, position, hunger, item count |

---

## Discord Commands

Prefix: `!bot`

| Command | Description |
|---|---|
| `!bot help` | Command reference |
| `!bot status` | Full status embed |
| `!bot health` | HP and hunger only |
| `!bot resources` | Memory / uptime report |
| `!bot connect` | Connect to Minecraft |
| `!bot disconnect` | Disconnect bot |
| `!bot follow` | Follow authorized user |
| `!bot stop` | Stop all tasks |
| `!bot go <x> <y> <z>` | Navigate to coords |
| `!bot ai on\|off` | Toggle AI brain |
| `!bot logs [n]` | Show last n log lines |

---

## License & Usage

This software is provided for personal, educational, and non-commercial use only. The author is not responsible for misuse, including but not limited to: use on servers without permission, automation that violates server rules, or activity that breaches Replit's Terms of Service.
