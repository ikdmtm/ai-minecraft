# Gameplay autonomy: operations, evidence and persistent procedures

This is the gameplay-only runtime (`npm run start:gameplay`). The streaming, avatar,
TTS and old cognitive production pipeline are unchanged. Legacy high-level body
methods remain for compatibility; the new executive does not call `HUNT_FOOD`,
`COOK_FOOD`, `BUILD_SHELTER` or a predefined progression.

## Running

Keep the existing `.env` credentials and model names. Use `POLICY_PROVIDER=openai`
for the full structured-operation interface. The JEV adapter is still a
choice-only compatibility path; it cannot supply arbitrary operation arguments or
save/replay procedures. This is a limitation, not an automatically learned skill.

```sh
npm ci
npm run lint
npm test
npm run build
npm run mc:start
npm run start:gameplay
```

`mc:start` exports vanilla recipes and tags from the installed server JAR to
`data/minecraft-knowledge.json` using Python 3. It unwraps Mojang's bundled JAR,
checks its embedded checksum, checks Minecraft version, and caches unchanged
exports. Without a matching export, the model is explicitly told that processing
recipe data is unavailable. Custom server datapacks are not part of this export.

## What the agent receives

* Current player/world state, inventory and a compact local 5×5×5 physical grid.
  Grid cells distinguish loaded air from unloaded terrain. This is geometry, not
  a proposed house or mining plan.
* The currently open window, its actual window ID, all slot indices and contents,
  and registry-provided slot roles. An opened container remains open for subsequent
  operations. Stale window IDs and incompatible transfers are rejected.
* On-demand `LOOKUP_KNOWLEDGE` queries over versioned item/block/entity/window facts
  and exported vanilla recipes/tags. Queries have explicit pagination.
* Recent operation evidence, world-scoped observations and transferable experience,
  plus compatible learned procedures. Food data is read from `foodsByName`; item
  IDs from a different inherited data version are not treated as food IDs.

## General controls

`EXECUTE_OPERATION` accepts a strict, validated data object for:

`MOVE`, `LOOK`, `BREAK`, `PLACE`, `ATTACK`, `EQUIP`, `USE`, `INTERACT_BLOCK`,
`INTERACT_ENTITY`, `OPEN`, `CLOSE`, `TRANSFER`, `CRAFT`, `WAIT`.

The agent chooses targets, equipment, recipes, slots, counts and operation order.
For example, a furnace is used by opening its interface and issuing individual
slot transfers, not by invoking a human-written cooking plan. Crafting uses one
selected recipe invocation (up to 16 repetitions); it does not obtain missing
materials or place a workbench automatically.

Movement executes a bounded path segment without implicit digging or scaffolding.
Breaking a block does not auto-collect its drops. An attack is one strike, not an
assumed kill. Physical checks reject unreachable targets, removing the current
support block and placing a block through the player's body. These checks are
adapter/safety invariants rather than a survival strategy.

`WAIT` has an explicit bounded duration and optional observable condition. The
operation stays active without repeatedly calling the model. Timeout is distinct
from condition satisfaction. Health loss and safety interruption wake it; an
intentional running wait is not reported as a gameplay stall.

## Learned procedures

After a useful demonstrated sequence, the model can choose `SAVE_PROCEDURE` with
2–12 **consecutive, succeeded and effect-verified evidence IDs** and a name. The
runtime refuses invented evidence, failed/no-effect demonstrations and arbitrary
code. It stores a declarative sequence of operations, not JavaScript or shell code.

The resulting procedure starts as `candidate`. `RUN_PROCEDURE` rebinds block/entity
names, relative placement offsets and inventory slots in the current world. It
checks the Minecraft version, dimension, window type and each step's live
preconditions/effect. Targets are not copied as absolute coordinates or old entity
IDs. Replay is bounded and interruptible. Two successful replays with no failures
promote it to `verified`; a later failure makes it a candidate again.

This is external experience/procedural memory, **not model-weight training**.
Verification is empirical, not a guarantee that a procedure works in every layout.
The model still needs to discover useful sequences; saving an observation count
alone is not described as having learned a skill.

## Memory and world lifecycle

All persistent data lives in `DB_PATH` (default `./data/gameplay.db`), outside the
Minecraft world folder. It contains scoped observations, operation evidence and
learned procedures. Do not delete this database when resetting the world.

The local server's world identity is stored at
`.minecraft-dev/server/world/.ai-world-id` (under `MC_DEV_DIR` when set). Restarting
keeps it. Deleting/resetting the world removes it; the next start creates a new
UUID even when the seed is unchanged. Old spatial observations remain historical
records and are excluded from the new world's live navigation. Global experience
and compatible procedures remain available. Loss of confidence evicts old working
memory, not the stored history.

For remote servers, set `GAMEPLAY_WORLD_ID` to a stable, unique ID for that actual
world, and change it only when the world is replaced. Alternatively set
`GAMEPLAY_WORLD_ID_FILE`. A seed alone is not a safe world identifier.

```sh
# New local world, same test seed, retained AI experience:
npm run mc:reset -- 8675309
npm run start:gameplay
```

Stop the agent before a reset. `nextGeneration()` also requires the runtime to be
stopped and rotates local identity while preserving global memory.

## Verification

```sh
npm run lint
npm run build
npm test
python3 scripts/test-export-knowledge.py
# Requires Java 21 + an installed 1.21.4 server JAR; runs NO LLM requests:
npm run test:gameplay-smoke
```

The smoke test always creates its own disposable world in the operating system's
temporary directory. It uses console commands to create fixtures and verifies real
place/open/transfer/furnace-output/close/equip/break/move/pickup mechanics. It is an
adapter integration test, **not evidence of autonomous Hardcore survival**.

Remaining limits: only controls implemented by this adapter can be executed;
custom datapack knowledge and certain specialized inventory/entity interfaces
still need adapters. There is no arbitrary code execution, comprehensive
long-term memory consolidation or proof of general survival competence. A genuine
multi-day autonomous run must be measured separately.
