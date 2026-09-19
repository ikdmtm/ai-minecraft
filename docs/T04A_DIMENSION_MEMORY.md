# T04a-2a: dimension-scoped spatial memory and evidence

Base: `934df90c736453dd85eacf2911171b68eb3fb988` (PR #6 / T04a-1 merged).
Work branch: `fix/t04a2-dimension-memory`.
Status at creation: IMPLEMENTED; consult the associated PR for exact-head CI and integration results.

## Task split before implementation

T04a-2 crosses two independently testable boundaries:

- **T04a-2a (this change):** persisted dimension identity, dimension-specific observation/recall/live targets, source-context attribution of operation evidence, and refusal to save cross-context completion as a placement in the destination.
- **T04a-2b (next):** immediate runtime cancellation/gating on respawn/dimension transition, stale Planner/Executive responses, readiness after spawn, and an A->B->A transition while work is in flight. Do not mark T04a-2 or T04a as a whole complete yet.

Only three implementation files change: `worldMemory.ts`, `semanticWorldModel.ts`, `taskExecutor.ts`. Tests are in `dimensionMemory.test.ts`. No progression script, crafting policy, recipe knowledge, streaming, or model-weight training changes.

## Changes and compatibility

`gameplay_memory.dimension` is added with a transactionally checked, additive SQLite migration. Old rows retain their IDs, payloads and coordinates with NULL dimension. They are not guessed to belong to overworld. No old history or global experiences/procedures are deleted. Existing current-world coordinates without dimension need re-observation before being used as current navigation targets.

New spatial IDs contain world, normalized dimension, kind and key as an unambiguous tuple. The world ID still identifies the server/world selected in T04a-1; a dimension is not a new world or generation.

Known vanilla spellings (`overworld`, `the_nether`, `nether`, `the_end`, `end`) normalize to namespaced resource locations. Namespaced custom dimensions remain distinct. Unknown/missing dimension values are not silently mapped to overworld.

`WorldMemory.recall({ dimension })` filters before ranking and limiting. A call without dimension requests legacy/unknown records only, not all dimensions. Runtime spatial recall always supplies the observed dimension and suppresses spatial recall when it is unknown. Global recall remains independent. `recallHistory(worldId)` intentionally includes all dimensions and NULL legacy records as history.

Entity/resource observations and verified self-placements carry the observed dimension. Coordinate-based contradiction updates match both world and dimension, so breaking a nether block cannot invalidate the overworld record at the same coordinates.

`SemanticWorldModel.capture()` checks the context before using provenance. On an observed world/dimension change it clears its transient physical provenance, surface anchor and cached lookup results. Persisted dimension-scoped memories remain. Revisions include world/dimension so otherwise-identical observations invalidate an old decision. Current-context recent evidence is filtered by both world and dimension.

Task execution captures its starting world/dimension. At task/operation boundaries, changed context is classified as interrupted. Such a result cannot be saved as a verified placement or a negative procedure example in the new dimension. Evidence keeps the source world, dimension and version; its effect explicitly describes the context change rather than comparing two different maps as though a block changed in one map.

## Tests and limits

New tests use actual temporary SQLite databases, the actual SemanticWorldModel/TaskExecutor, and mocked physical bot/primitive results. They exercise:

- Three records with identical key/XYZ in overworld/nether/end; reopen and individual recall.
- Filtering before recall limits, per-dimension contradiction, global recall and different world IDs.
- An actual pre-migration SQL schema, additive reopen, preserved legacy rows and unknown-dimension behavior.
- Live semantic targets, prompt memory and recent evidence separation; return to the first map.
- Clearing stale in-memory provenance on a captured context change.
- Verified PLACE/BREAK dimension attribution and a delayed completion after a dimension/world change.

They do **not** simulate a full live portal crossing or prove immediate cancellation of packet-producing operations. Existing Minecraft 1.21.4 adapter smoke runs only as a regression test. No user's live world or operational database is used and no paid LLM call is made.

Known remaining transition gaps are explicit: the task boundary check cannot notice A->B->A if no check occurs in between; it does not itself interrupt an adapter at the transition instant. The Planner's pending response and pre-spawn readiness also need runtime lifecycle handling. Those belong to T04a-2b, not a claimed success here.

## Next single task

After checking exact-head CI and integration of this PR: **T04a-2b only**. Bind a monotonic spatial transition epoch to immediate primitive/task cancellation and policy result validation; prevent observations/actions before destination readiness; keep late finalizers scoped to their origin. Test delayed operations, delayed planning replies, same-dimension respawn and A->B->A. Preserve this PR's scoped persistence and all historical/global experience. Do not combine with T04b/T04c/T05/T06.
