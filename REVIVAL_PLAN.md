# AI Minecraft Revival Plan — Gameplay First

Date: 2026-09-17
Baseline: `main` at `5caef7d87e035a4d62d9a31a56d056352c157298`

## 1. Revival objective

This project is being revived with a different development priority.

The immediate objective is **not** to produce a polished YouTube/VTuber stream. The immediate objective is to build an AI agent that can play Minecraft competently, continuously, and autonomously.

Streaming, TTS, subtitles, avatar rendering, lip sync, YouTube integration, and presentation polish remain valuable existing assets, but they are frozen until the gameplay system reaches an acceptable level of reliability and autonomy.

The original long-term concept remains useful: an autonomous AI character that survives in Minecraft Hardcore, learns from previous runs, and can eventually be presented as a VTuber/live-streamed character. The implementation order is now explicitly changed to gameplay first.

## 2. Development phases

### Phase 0 — Establish a clean gameplay-only development path

Goal: run and observe the Minecraft agent without depending on YouTube, FFmpeg, TTS, avatar, subtitles, or stream lifecycle code.

Required outcomes:

- Start Minecraft server + Mineflayer agent with one command or a small documented sequence.
- Start `CognitiveOrchestrator` independently from the streaming runtime.
- Log decisions, actions, failures, progress, inventory, position, threats, and goals in a way that is easy to inspect.
- Allow repeated local/manual test runs.
- Preserve the existing streaming implementation without deleting it.

### Phase 1 — Make the bot reliably play Minecraft

Focus on action execution before improving higher-level intelligence.

Priority areas:

- movement/pathfinding reliability
- mining and resource collection
- crafting dependency chains
- food acquisition and eating
- combat and retreat
- shelter / night handling
- inventory/tool management
- recovery from unreachable targets and stalled actions
- detecting actual progress vs. repeated no-progress loops
- goal changes interrupting stale actions

A gameplay action must report whether it actually made progress. Silent failure followed by repeating the same action is considered a core bug.

### Phase 2 — Restore and improve layered cognition

Keep the current three-timescale architecture, but sharpen responsibilities:

1. **Reflex layer — deterministic code**
   - immediate survival-critical reactions
   - lava, fire, creeper proximity, critical HP, emergency eating, etc.
   - fast and predictable; no network model dependency

2. **Intuition / tactical layer — Jev candidate**
   - frequent state-dependent decisions
   - continue vs interrupt
   - fight vs flee
   - return to base vs continue task
   - select next skill/action
   - threat/risk classification
   - decide whether a higher-level replan is needed
   - use confidence/probabilities to gate actions or escalate uncertain decisions

3. **Strategic layer — general LLM**
   - long-term goals
   - multi-step plans
   - adapting strategy from progress and previous deaths
   - generating new goals when the current plan is exhausted or invalid

The Jev integration is intentionally **not** the first implementation task. First stabilize state collection, action execution, progress/failure reporting, and a gameplay-only harness so Jev can be evaluated against a reliable environment.

### Phase 3 — Evaluation and learning

Add repeatable evaluation rather than judging the agent only by watching it.

Track at minimum:

- survival time
- time to first wood / stone / iron
- time to stable food
- time to shelter/bed
- tool/armor progression
- deaths and death causes
- number of stalled/repeated actions
- action success/failure rates
- unnecessary combat entries
- successful retreats
- goal completion rate

Use these metrics to compare tactical implementations (rules vs. Jev vs. LLM-assisted variants).

### Phase 4 — Presentation layer returns

Only after gameplay is strong enough to be interesting on its own:

- natural commentary generation
- TTS
- subtitles
- VTuber avatar
- lip sync
- stream overlays
- YouTube Live lifecycle
- long-running autonomous broadcast operation

## 3. Existing assets to preserve

The repository already contains useful work that should not be rewritten without a reason:

- Mineflayer integration
- pathfinder integration
- `ReflexLayer`
- `TacticalLayer`
- `StrategicLayer`
- `SharedStateBus`
- episodic memory
- skill library
- SQLite persistence
- death-generation loop concepts
- YouTube/FFmpeg/TTS/avatar/subtitle implementation
- deployment and architecture documentation

Streaming-related code is currently **out of scope**, not deprecated.

## 4. Known restart concern

The commit history shows that gameplay fixes related to no-progress loops, goal-change interruption, and richer action progress reporting were implemented and then reverted while later work focused on streaming/runtime restoration.

Before introducing Jev, review those reverted changes and reintroduce the useful behavior deliberately with tests rather than blindly cherry-picking the old commits.

## 5. First implementation milestone

The first milestone for this revival is:

> **Run the agent in a gameplay-only mode and have it autonomously progress from spawn through basic early-game survival without YouTube/TTS/FFmpeg dependencies.**

Suggested acceptance criteria for the first milestone:

- spawn reliably
- collect wood
- craft basic tools
- obtain food or establish a viable food path
- obtain stone tools
- survive the first night or intentionally create a safe shelter
- recover from at least one unreachable/stalled action without manual intervention
- emit structured logs showing goals, chosen actions, results, and failures

After this milestone is stable, integrate Jev into the tactical/intuition layer and evaluate whether it improves decision quality and responsiveness.

## 6. Relationship to the original specification

`ai_minecraft_stream_spec_hoshimori_rei.md`, `ARCHITECTURE.md`, `DEPLOY.md`, and the existing source tree remain historical/current reference material.

Where this revival plan conflicts with the old implementation order, **this document controls development priority**:

**Gameplay quality → tactical intelligence/Jev → evaluation → commentary/TTS → VTuber presentation → live streaming.**
