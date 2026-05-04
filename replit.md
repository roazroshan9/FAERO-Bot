# Overview

This project is a pnpm workspace monorepo utilizing TypeScript, centered around FAERO, a standalone CommonJS JavaScript AI Minecraft bot. FAERO employs a modular plugin architecture to automate various in-game tasks such as pathfinding, block collection, PvP, armor management, auto-eating, and tool selection. It also features an Express and Socket.IO-based browser control panel for management and a Discord bridge with RBAC and rate-limiting capabilities.

The primary goal of FAERO is to provide an advanced, autonomous Minecraft AI agent capable of intelligent survival, combat, and construction within the game world. Future ambitions include developing a "Hive Mind" for collective intelligence among multiple bots, an advanced tactical combat engine, a neural social engine for improved human interaction, and an adaptive world oracle for predictive resource management and player profiling. The project aims to elevate FAERO to an elite-tier collective intelligence, offering sophisticated automation and strategic gameplay advantages.

# User Preferences

I want to interact with the bot through a web control panel or Discord commands. I expect the bot to proactively alert me about important events (e.g., bot kicked, build status). I prefer a cyberpunk-themed UI for the web control panel. I also expect the bot to manage its resources efficiently, avoid spamming notifications, and provide clear status updates on its operations.

# System Architecture

The project is structured as a pnpm monorepo with Node.js 24 and TypeScript 5.9. The core of FAERO is a CommonJS JavaScript bot built with Mineflayer.

**UI/UX Decisions:**
The web control panel features a cyberpunk glassmorphism UI with neon accents, scanlines, glowing status indicators, and animated logs. It includes movement controls, chat, and visible AI state readouts.

**Technical Implementations:**

*   **Plugin System**: A dynamic plugin loader (`core/pluginLoader.js`) automatically discovers and integrates `.plugin.js` files, enabling modular functionality.
*   **Self-monitoring**: `core/monitor.js` tracks system resources (heap, CPU) and initiates auto-disconnection if critical thresholds are breached. An `emergencyMonitor.js` sends critical alerts to Discord on severe events (low health, combat damage, unexpected disconnects), with cooldowns to prevent spam.
*   **Persistence**: Uses MongoDB (via Mongoose) for storing user roles, saved locations, and logs. It seamlessly falls back to a local-only mode if MongoDB is unavailable.
*   **Survival Automation**: `modules/survival.js` handles automatic tool crafting (`ensurePickaxe()`) and configuration of `mineflayer-auto-eat`. `modules/inventory.js` provides inventory sorting.
*   **Security & Access Control**: Implements per-user and global sliding-window rate limiting in `discord/client.js`. Role-Based Access Control (RBAC) is defined in `config/roles.js` with OWNER, ADMIN, MANAGER, and NONE tiers for Discord and in-game commands.
*   **Combat AI**: `modules/combatAI.js` features a dynamic engagement loop with mob-specific tactics, health-aware retreat and re-engagement, sword cooldown timing, post-combat drop collection, and a maximum chase distance. All thresholds are environment-configurable.
*   **Death Logging & Recovery**: Records death coordinates and causes to MongoDB. Upon respawn, the bot navigates to the death location to collect drops and marks the death as recovered. A REST API (`/bot-api/deaths`) and dashboard panel display this information.
*   **Waypoints**: Persistent named locations stored in MongoDB. Accessible via in-game commands (`!waypoint`) and Discord (`!bot waypoints`). A dedicated dashboard panel and REST API (`/bot-api/waypoints`) are available.
*   **Auto Build**: `modules/autoBuild.js` provides a schematic-based block placement engine with built-in schematics (e.g., `platform_5x5`, `tower_3x3`, `house_small`, `staircase_8`). It supports custom schematics, pathfinding, inventory management, and chest-pull fallback.
*   **Fleet Manager**: `core/fleetManager.js` orchestrates multiple bot instances (`FleetBot`). It manages group commands (follow, stop, come, join, leave, attack) and distributed builds, splitting block placement tasks across online bots. Provides real-time status via Socket.IO and a comprehensive REST API (`/bot-api/fleet/*`).
*   **Discord Fleet Bridge**: `modules/discordFleet.js` extends the Discord bridge with fleet-specific commands (`!fleet`) for control and proactive alerts for events like bot kicks or build status.
*   **Schematic Lab**: A dashboard panel for uploading, validating, saving, and deploying custom schematics. Schematics are stored in-memory per session and can be deployed to the fleet.
*   **Bot Runtime**: The bot and a lightweight web control panel run within a single Node.js process using `app.js` and `startup.sh`. The control panel serves the browser UI, Socket.IO events, and bot REST endpoints.
*   **AI Throttling**: Aggressive AI throttling measures are implemented, including cached mob scans, capped entity scans, a CPU usage gate, two-minute ore scan intervals, action cooldowns for expensive tasks, and bounded memory cleanup to optimize resource usage.

**Feature Specifications:**

*   **Custom Schematic Format**: Supports JSON schematics with relative (`dx/dy/dz`) or absolute (`x/y/z`) block coordinates.
*   **Hive Mind**: `core/hiveMind.js` acts as a singleton EventEmitter for collective intelligence, providing a shared memory bus, collective resource pool, task delegation engine, fleet health monitoring, and danger zone persistence.
*   **Autonomous Survival v2**: Enhanced full survival loop for all bots, including food chain management and night shelter.
*   **Tactical Combat Engine**: `modules/tacticalCombat.js` — singleton EventEmitter providing Formation System (Wedge, Pincer, Shield Wall with rotation geometry), auto Role Assignment scoring (Tank/DPS/Support by health+armor+sword+food), Focus-Fire Target Locking (fleet-wide entity lock with TTL and live resolution), and Staggered Attack Timing (slot×staggerStep ms per bot). Integrated into HiveMind status snapshot, FleetManager group commands (`formation`, `assign_roles`, `lock_target`, `engage`, `abort`), REST API (`/bot-api/tactical/*`), and Socket.IO event bridge (`tactical:*` events piped to dashboard and hive intel feed).
*   **Neural Social Engine**: Planned for persistent conversation memory and improved human interaction.
*   **Adaptive World Oracle**: Planned for server map learning, player behavior profiling, and predictive resource routing.

# External Dependencies

*   **Monorepo Tool**: pnpm workspaces
*   **Minecraft Bot Library**: Mineflayer
*   **Web Server Framework**: Express 5
*   **Real-time Communication**: Socket.IO
*   **Database**: PostgreSQL
*   **ORM**: Drizzle ORM
*   **Validation**: Zod (`zod/v4`), `drizzle-zod`
*   **API Codegen**: Orval (from OpenAPI spec)
*   **Build Tool**: esbuild (for CJS bundle)
*   **Discord Integration**: Discord.js (implied by Discord bridge functionality)
*   **MongoDB**: (Used for persistence, via Mongoose)