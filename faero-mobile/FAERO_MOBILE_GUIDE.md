# FAERO Mobile — Build Guide

Complete instructions for turning this scaffold into a working Android APK.

---

## 1 — Prerequisites (your local build machine)

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 18 | https://nodejs.org |
| npm | ≥ 9 | bundled with Node |
| JDK | 17 (LTS) | https://adoptium.net |
| Android Studio | Latest | https://developer.android.com/studio |
| Android SDK | API 33 | via Android Studio SDK Manager |

Set environment variables:
```bash
export JAVA_HOME=/path/to/jdk17
export ANDROID_HOME=$HOME/Android/Sdk        # macOS/Linux
# set ANDROID_HOME=C:\Users\you\AppData\Local\Android\Sdk   # Windows
export PATH=$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/tools
```

---

## 2 — One-time setup (run once after cloning)

```bash
# In the faero-mobile/ directory:
npm install                          # install Cordova locally
npm run setup                        # adds android platform + nodejs-mobile plugin
```

This runs:
```
cordova platform add android
cordova plugin add nodejs-mobile-cordova
```

---

## 3 — Paste your FAERO files

### 3A — Node.js bot backend → `www/nodejs-project/`

Copy these folders/files from your existing FAERO project:

```
www/nodejs-project/
├── index.js          ← ALREADY HERE (wire your BotManager in here)
├── package.json      ← ALREADY HERE (dependencies pre-filled)
│
│   ── Paste these from your FAERO project ──
├── core/
│   ├── botManager.js
│   ├── hiveMind.js
│   ├── stateManager.js
│   └── ...
├── modules/
│   ├── scanner.js
│   ├── socialEngine.js
│   ├── worldOracle.js
│   └── ...
├── ai/
│   ├── brain.js
│   ├── chatResponder.js
│   └── ...
├── lib/
│   └── persistence/
│       ├── mongo.js
│       └── models.js
├── .env              ← your secrets (DO NOT commit this)
└── startup.sh        ← optional
```

After pasting, open `www/nodejs-project/index.js` and replace the stub:

```js
// BEFORE (stub):
class BotManagerStub { ... }
const botManager = new BotManagerStub();

// AFTER (real):
const BotManager = require('./core/botManager');
const botManager = new BotManager();

// Wire events → bridge:
botManager.on('log',   (e) => bridge.send('log',    e));
botManager.on('bot',   (s) => bridge.send('status', s));
botManager.on('chat',  (c) => bridge.send('chat',   c));
```

Then install the backend's npm dependencies on your build machine:

```bash
cd www/nodejs-project
npm install --production
cd ../..
```

> **Important:** `npm install` must run *before* building the APK.
> nodejs-mobile bundles the entire `www/nodejs-project/` folder
> (including `node_modules/`) into the APK.
> Native modules (with `.node` bindings) must be re-compiled for Android —
> nodejs-mobile-cordova handles this automatically via its build hook.

---

### 3B — Web control panel → `www/`

The mobile web panel (`www/index.html`, `www/css/app.css`, `www/js/app.js`)
is already built and ready.  You can optionally copy your existing
FAERO dashboard (`web/public/`) over the top of `www/` if you prefer
the full desktop UI in a scrollable WebView.

If you keep the mobile UI, customise these files:
- `www/index.html` — add more tabs / controls as needed
- `www/css/app.css` — tweak the cyberpunk theme
- `www/js/app.js`  — add handlers for any new bot commands

---

## 4 — Build the APK

### Debug build (for testing):

```bash
cordova build android
# Output: platforms/android/app/build/outputs/apk/debug/app-debug.apk
```

### Release build (for distribution):

```bash
# 1. Generate a signing keystore (one-time):
keytool -genkey -v -keystore faero-release.keystore \
        -alias faero -keyalg RSA -keysize 2048 -validity 10000

# 2. Build release APK:
cordova build android --release -- \
  --keystore=faero-release.keystore \
  --alias=faero \
  --storePassword=YOUR_STORE_PASS \
  --password=YOUR_KEY_PASS

# Output: platforms/android/app/build/outputs/apk/release/app-release.apk
```

---

## 5 — Install on device

```bash
# USB debugging must be enabled on the device
cordova run android                  # build + deploy to connected device
adb install platforms/android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 6 — Project file structure (complete)

```
faero-mobile/
│
├── config.xml                    ← Cordova app config (DO NOT delete)
├── package.json                  ← Build scripts + Cordova meta
├── .gitignore
│
├── www/                          ← Everything that goes into the WebView
│   ├── index.html                ← Mobile control panel UI
│   ├── css/
│   │   └── app.css               ← Cyberpunk mobile styles
│   ├── js/
│   │   └── app.js                ← Bridge + UI logic
│   └── nodejs-project/           ← Node.js backend (bundled into APK)
│       ├── index.js              ← Entry point (wire your BotManager here)
│       ├── package.json          ← Bot npm dependencies
│       ├── node_modules/         ← Created by: cd nodejs-project && npm install
│       │
│       │   ── PASTE YOUR FAERO FILES HERE ──
│       ├── core/
│       ├── modules/
│       ├── ai/
│       └── lib/
│
├── platforms/                    ← Created by: cordova platform add android
│   └── android/                  ← Full Gradle project (auto-generated)
│
├── plugins/                      ← Created by: cordova plugin add ...
│   └── nodejs-mobile-cordova/    ← The Node.js runtime plugin
│
├── hooks/
│   └── README.md                 ← How to add pre-build npm install hook
│
└── res/
    └── android/                  ← App icons + splash screen
        ├── mipmap-mdpi/
        ├── mipmap-hdpi/
        ├── mipmap-xhdpi/
        ├── mipmap-xxhdpi/
        ├── mipmap-xxxhdpi/
        └── drawable/
```

---

## 7 — How the Node.js ↔ WebView bridge works

```
┌─────────────────────────┐          ┌─────────────────────────────┐
│   WebView (www/js/app.js)│          │  Node.js (nodejs-project/)  │
│                         │          │                             │
│  nodejs.channel.send()  │────────► │  cordova.channel.on()       │
│  nodejs.channel         │◄──────── │  cordova.channel.send()     │
│    .setListener()       │          │                             │
│                         │          │  Mineflayer bot running here│
└─────────────────────────┘          └─────────────────────────────┘
         Android WebView                    Node.js Thread
```

All messages are JSON strings: `{ "type": "connect", "data": { ... } }`

Message types the backend handles:
- `connect`    — start the bot (host, port, username, password)
- `disconnect` — stop the bot
- `command`    — run a bot command (mine, farm, follow, chat, etc.)
- `status`     — request current bot status
- `ping`       — health check

Message types the frontend receives:
- `ready`   — backend started, Node version
- `status`  — bot state, health, food, position
- `log`     — log entry from the bot
- `chat`    — incoming Minecraft chat message
- `error`   — error from the bot

---

## 8 — Common issues

| Problem | Fix |
|---------|-----|
| `JAVA_HOME not set` | Set `JAVA_HOME` to your JDK 17 path |
| `SDK location not found` | Set `ANDROID_HOME` or create `local.properties` |
| `Execution failed for task :app:mergeDebugNativeLibs` | Run `npm install` in `www/nodejs-project/` first |
| Native modules crash on device | Check nodejs-mobile-cordova version ≥ 0.3.3 supports your node version |
| App killed in background | Add `cordova-plugin-background-mode` |
| Bot disconnects when screen off | Add `cordova-plugin-insomnia` + `WAKE_LOCK` permission (already in config.xml) |
