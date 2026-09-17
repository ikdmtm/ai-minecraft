# Local Gameplay Development (WSL2)

This is the primary development path during the gameplay-first revival.

The existing AWS / YouTube / FFmpeg / TTS stack remains in the repository, but it is not required for gameplay development.

## Recommended daily workflow

WSL2 Ubuntu is the canonical development environment.

After the repository exists locally, normal verification should require only:

```bash
cd /home/ikdmtm/dev/ai-minecraft
bash run.sh
```

`run.sh` automatically:

1. fetches and fast-forwards `revive/gameplay-first-jev`
2. installs missing Ubuntu prerequisites when necessary
3. runs `npm ci` when `package-lock.json` changed or `node_modules` is missing
4. creates/migrates `.env`
5. asks for the selected API key only when it is not configured yet
6. prepares the local Minecraft server on first run
7. starts the Minecraft server if needed
8. starts the gameplay-only AI

For a fresh fixed-seed regression test:

```bash
bash run.sh reset 8675309
```

The launcher keeps `.env`, Minecraft runtime files, worlds, and local state out of Git.

## Goal

Run these components locally:

- Minecraft Java server (Hard difficulty + Hardcore world)
- Mineflayer agent (`AI_Rei` by default)
- cognitive orchestrator
- SQLite state / memory
- structured console logs

Streaming, TTS, subtitles, avatar rendering, FFmpeg, and YouTube are intentionally not started.

## LLM provider

Gameplay-first development currently defaults to OpenAI:

```dotenv
LLM_PROVIDER=openai
OPENAI_API_KEY=your-key
TACTICAL_MODEL=gpt-5.6-luna
STRATEGIC_MODEL=gpt-5.6-terra
```

The tactical model is called frequently, so Luna is used for the cost-sensitive fast path. Strategic planning runs less frequently and defaults to Terra.

Anthropic remains supported by setting `LLM_PROVIDER=anthropic` and configuring `ANTHROPIC_API_KEY` plus optional model overrides.

Do not commit `.env` or API keys.

## Manual prerequisites / fallback

The one-touch launcher installs these when missing, but they can also be installed manually:

```bash
sudo apt update
sudo apt install -y openjdk-21-jre-headless curl jq
```

Node.js 20+ is also required; the launcher installs Node.js 20 when it is absent or too old.

## Manual server commands

First-time Minecraft server setup:

```bash
npm run mc:setup
```

Runtime files are written under:

```text
.minecraft-dev/server/
```

Start:

```bash
npm run mc:start
```

Status:

```bash
npm run mc:status
```

Stop:

```bash
npm run mc:stop
```

Start only the gameplay AI:

```bash
npm run start:gameplay
```

For code iteration without the one-touch launcher:

```bash
npm run dev:gameplay
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

Gameplay runtime settings include:

```dotenv
MINECRAFT_HOST=localhost
MINECRAFT_PORT=25565
BOT_USERNAME=AI_Rei
GAMEPLAY_STATUS_INTERVAL_MS=2000
GAMEPLAY_STALL_THRESHOLD_MS=20000
GAMEPLAY_STALL_ALERT_COOLDOWN_MS=15000
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
