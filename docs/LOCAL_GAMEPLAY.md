# Local Gameplay Development (WSL2)

This is the primary development path during the gameplay-first revival.

The existing AWS / YouTube / FFmpeg / TTS stack remains in the repository, but it is not required for gameplay development.

## Goal

Run these components locally:

- Minecraft Java server (Hard difficulty + Hardcore world)
- Mineflayer agent (`AI_Rei` by default)
- cognitive orchestrator
- SQLite state / memory
- structured console logs

Streaming, TTS, subtitles, avatar rendering, FFmpeg, and YouTube are intentionally not started.

## Prerequisites

Recommended environment:

- Windows 11
- WSL2 Ubuntu
- Node.js 20+
- Java 21+
- `curl`
- `jq`

Install Ubuntu prerequisites if needed:

```bash
sudo apt update
sudo apt install -y openjdk-21-jre-headless curl jq
```

From the repository:

```bash
npm ci
cp .env.example .env
```

Set a valid `ANTHROPIC_API_KEY` in `.env` for the current tactical/strategic implementation.

## First setup

Download and configure the local Minecraft 1.21.4 server:

```bash
npm run mc:setup
```

Runtime files are written under:

```text
.minecraft-dev/server/
```

That directory is gitignored.

## Normal development loop

Start the Minecraft server:

```bash
npm run mc:start
```

Check it:

```bash
npm run mc:status
```

In another terminal, start only the AI gameplay runtime:

```bash
npm run start:gameplay
```

For code iteration:

```bash
npm run dev:gameplay
```

Stop the Minecraft server:

```bash
npm run mc:stop
```

## Resetting the Hardcore world

Random seed:

```bash
npm run mc:reset
```

Fixed numeric seed for reproducible tests:

```bash
npm run mc:reset -- 8675309
```

Use the same fixed seed while working on an action bug so before/after behavior can be compared under similar conditions. Use random seeds later to test generalization.

`mc:reset` stops the server, removes all dimensions, sets the requested seed, and starts the server again.

To remove the world without restarting:

```bash
MC_RESET_NO_START=1 npm run mc:reset -- 8675309
```

## Useful overrides

The server scripts accept shell environment variables:

```bash
MC_VERSION=1.21.4 npm run mc:setup
MC_JAVA_XMS=1G MC_JAVA_XMX=4G npm run mc:start
MC_START_TIMEOUT_SECONDS=120 npm run mc:start
```

The AI runtime reads `.env` and supports at least:

```dotenv
MINECRAFT_HOST=localhost
MINECRAFT_PORT=25565
BOT_USERNAME=AI_Rei
TACTICAL_MODEL=claude-haiku-4-5-20251001
STRATEGIC_MODEL=claude-sonnet-4-6
GAMEPLAY_STATUS_INTERVAL_MS=2000
DB_PATH=./data/gameplay.db
```

## Windows Minecraft client (optional observer)

A Windows Java Edition client can be used only as an observer during debugging. Connect to the WSL2-hosted server on `localhost:25565` when localhost forwarding is available.

The AI must not depend on the observer client. Gameplay correctness is evaluated from Mineflayer state, action results, logs, and repeatable tests.

## Development order

Do not optimize streaming presentation yet.

Current order:

1. make action execution reliable
2. make early-game Minecraft progression reliable
3. add repeatable gameplay metrics/evaluation
4. integrate Jev into the tactical/intuition layer
5. restore commentary/TTS/VTuber presentation
6. return to AWS for long-running tests and eventual live streaming

## First gameplay acceptance target

From a fresh Hardcore world, without manual intervention, the agent should reliably:

1. spawn and orient itself
2. find and collect wood
3. craft planks / crafting table / basic tool chain
4. obtain stone tools
5. establish a viable food path
6. survive the first night or create safe shelter deliberately
7. recover from an unreachable or stalled action
8. report action success/failure/progress clearly enough to diagnose mistakes

Only after this foundation is stable should tactical decision quality (including Jev) become the main variable under test.
