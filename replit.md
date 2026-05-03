# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

A standalone CommonJS JavaScript AI Minecraft bot (FAERO) has been added at the repository root. It uses a modular plugin architecture with Mineflayer plugins for pathfinding, block collection, PvP, armor management, auto-eating, and tool selection, plus Express and Socket.IO for a browser control panel, and a Discord bridge with RBAC and rate limiting.

## FAERO Bot Architecture

- **Plugin system**: `core/pluginLoader.js` — auto-discovers `plugins/*.plugin.js`
- **Built-in plugins**: `plugins/ai.plugin.js`, `plugins/combat.plugin.js`, `plugins/navigation.plugin.js`
- **Self-monitoring**: `core/monitor.js` tracks heap MB + CPU % and auto-disconnects on SAFE_HEAP_MB breach
- **Emergency monitor**: `core/emergencyMonitor.js` — fires red Discord embed (with `@OWNER` mention) on health<15%, combat damage, or unexpected disconnect; per-reason cooldown prevents spam
- **Persistence**: `lib/persistence/mongo.js` + `lib/persistence/models.js` — Mongoose schemas for `UserRoles`, `SavedLocations`, `Logs`. Reads `MONGODB_URI` from `.env` / Replit Secrets; **falls back to Local-Only Mode automatically** when the URI is missing or unreachable
- **Survival automation**: `modules/survival.js` provides `ensurePickaxe()` (auto-craft on tool break inside `!mode mine`) and `mineflayer-auto-eat` config; `modules/inventory.js` exports `sortInventory()` (called by `!sort` and the mine-mode loop at ≥90% capacity)
- **Rate limiting**: per-user + global sliding-window bucket in `discord/client.js`
- **RBAC**: `config/roles.js` — OWNER / ADMIN / MANAGER / NONE tiers for Discord and in-game commands; `!sort` and `!waypoint` are MANAGER-tier
- **CombatAI**: `modules/combatAI.js` — active engagement loop replacing the old flat 5s wait. Features: mob-specific tactics table (26 mobs), health-aware retreat (retreat at ≤6 HP, re-engage at ≥14 HP by default), sword cooldown timing (650ms), post-combat drop collection, max-chase-distance guard (30 blocks). All thresholds env-configurable. Guardian mode upgraded to use the full loop with overlap prevention. Danger watch range raised from 5 → 16 blocks.
- **Waypoints**: persistent named locations on top of `SavedLocations` collection. In-game: `!waypoint set|list|tp|delete <name>`. Discord: `!bot waypoints [tp <name>]` (red embed on not-found). Dashboard panel + REST API at `/bot-api/waypoints` (GET/POST, DELETE/:name, POST/:name/go) with unified error envelope `{ ok:false, error:{ code, title, message, color } }`

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Minecraft bot**: CommonJS JavaScript, Mineflayer, Express, Socket.IO

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm install` — install Minecraft bot dependencies
- `pnpm start` — run `startup.sh`, which starts the unified bot and web control entry point

## AI Minecraft Bot Structure

- `core/` — bot lifecycle, dynamic connection state, reconnect handling, state manager, task queue, persistent memory
- `ai/` — CommonJS think/decide/act brain and decision engine
- `modules/` — survival, combat, pathfinding, inventory, economy, and commands
- `web/` — Express server, Socket.IO bridge, and cyberpunk browser UI

## Minecraft Bot Runtime

The main application workflow runs `pnpm start`, which starts `startup.sh` and then `app.js`. `app.js` owns both the bot lifecycle and the lightweight web control panel in one Node process. The control panel serves the browser UI, WebSocket-only Socket.IO events, `/healthz`, and bot REST endpoints under `/bot-api/*`.

The browser control panel sends Host, Port, Username, and Auth values through Socket.IO when Connect is clicked. `core/botManager.js` stores the last successful connection options so reconnects reuse the dynamic UI values instead of falling back to defaults.

## Minecraft Bot Configuration

Set these environment variables before running when needed:

- `MC_HOST` — Minecraft server host, defaults to `localhost`
- `MC_PORT` — Minecraft server port, defaults to `25565`
- `MC_USERNAME` — bot username, defaults to `AI_Bot`
- `MC_AUTH` — Mineflayer auth mode, defaults to `offline`
- `MC_VERSION` — optional Minecraft version
- `AUTHORIZED_USER` — username allowed to command the bot, defaults to `roaz`
- `PVP_ENABLED` — set to `true` to allow safe PvP rules
- `WEB_PORT` or `PORT` — web control panel port, defaults to `3000`
- `AUTO_START_BOT` — set to `true` to connect the bot when the web server starts
- `BOT_RECONNECT_DELAY_MS` — clean bot restart delay, defaults to `10000`
- `BOT_MAX_RESTARTS` — maximum automatic bot restarts per window, defaults to `5`
- `BOT_TICK_MS` — AI loop interval, defaults to `10000` for lower CPU use
- `MOB_SCAN_INTERVAL_MS` — throttles mob scans, defaults to `15000`
- `ORE_SCAN_INTERVAL_MS` — throttles expensive ore scans, defaults to `120000`
- `RESOURCE_ACTION_INTERVAL_MS` — minimum delay between resource/pathfinding tasks, defaults to `120000`
- `SURVIVAL_ACTION_INTERVAL_MS` — minimum delay between survival tasks, defaults to `45000`
- `DANGER_ACTION_INTERVAL_MS` — minimum delay between danger/combat tasks, defaults to `20000`
- `AI_CPU_LIMIT_PERCENT` — skips new AI work when process CPU reaches this threshold, defaults to `30`
- `MEMORY_CLEANUP_INTERVAL_MS` — minimum interval between lightweight memory cleanup passes, defaults to `60000`
- `MEMORY_MAX_ATTACKERS`, `MEMORY_MAX_PAYMENTS`, `MEMORY_MAX_FACTS` — hard caps for stored bot memory maps, default to `50`

## Recent Updates

- Fixed `ai/decisionEngine.js` so `think`, `decide`, and `act` are separate functions exported as `module.exports = { act, think, decide }`.
- The previously unused `inventory` import is now used to build inventory and food-stock AI snapshots.
- Fixed dynamic connection and reconnect behavior for web-entered server details.
- Kept Socket.IO listeners inside the per-connection socket scope and sanitized AI thought payloads before broadcasting.
- Updated the web control panel with a cyberpunk glassmorphism UI, neon accents, scanlines, glowing status indicators, animated logs, movement controls, chat, and visible AI state readouts.
- Added a unified `app.js` entry point, `startup.sh`, and `core/processManager.js` to supervise bot crashes without spawning extra Node processes.
- Reduced web overhead by using WebSocket-only Socket.IO transport, smaller message limits, disabled compression, and a capped Express JSON body size.
- Reduced AI loop resource use by defaulting to a slower tick and throttling expensive ore scans.
- Added a lightweight resource dashboard showing CPU, RAM, process status, and restart count through a low-frequency metrics endpoint.
- Added aggressive AI throttling: cached mob scans, capped entity scans, a CPU gate at 30%, two-minute ore scan intervals, action cooldowns before expensive pathfinding/resource tasks are queued, smaller mining batches, and safer pathfinder movement defaults.
- Added bounded memory cleanup in `core/memory.js` so stale attack/payment/fact entries expire, maps are capped, strings are truncated, and status snapshots no longer deep-clone unbounded memory objects.
