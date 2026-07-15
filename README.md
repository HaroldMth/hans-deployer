# HANS MD — Deploy UI

A lightweight, zero-dependency local deployment platform for HANS MD.

## Requirements
- Node.js 18+
- `unzip` system utility (`sudo apt install unzip`)

## Usage

```bash
node server.js
# → http://localhost:8080
```

## Flow
1. Enter your Session ID
2. Configure feature toggles + RAM cap
3. Click **Deploy** — pulls latest GitHub release, installs, starts bot
4. Watch live logs stream in the terminal view
5. Return anytime with your SID to manage, tweak settings, or redeploy

## Disk Layout
```
hans-deploy/
├── server.js      ← zero npm deps
├── index.html     ← full SPA, all inline
├── state.json     ← auto-created, persists bot registry
└── bots/
    └── <slug>/    ← auto-created per bot on deploy
```

## RAM Cap
Each bot is monitored every 8 seconds via `/proc/<pid>/status`.
If RSS exceeds the cap, the bot is stopped automatically.
