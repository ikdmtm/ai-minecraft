# T05b — Rebind learned procedures to the current world

## Checkpoint

- Base: `4d40f04ac78ffe9f2790651a346d7148921b87b2` (T05a/PR #11).
- Work branch: `fix/t05b-procedure-rebinding`.
- Status at authoring: IMPLEMENTED, not yet CI-verified. Consult this branch's PR for the exact final head, CI logs and merge result.
- Scope: declarative procedure target relationships, relative coordinates, live window/inventory bindings and version/dimension compatibility only.
- No survival script, new model call, prompt/configuration change, data deletion or migration of historical evidence/statistics.

## Problems addressed

The previous binder merged all entities of one name into one live target, could choose a different same-named block on every step, and performed visibility checks inside the block scan predicate. CLOSE bound whichever window happened to be open. Inventory destination selection compared type/NBT but not metadata. Procedure listings applied a 64-row limit before environment filtering.

New templates use demonstration-local reference tokens. The actual evidence retains original positions and IDs for audit, but replay templates do not contain those old target coordinates/entity/window IDs. Two observed entities of one species get distinct references; repeated actions on one keep one reference. A placed block's reference is shared with subsequent operations on that same demonstrated coordinate. Runtime bindings are isolated per replay and are never persisted as live references.

Block candidates are resolved with blockAt before visibility checks. Selected coordinates remain pinned and must still be loaded, visible and the expected block name. The block API cannot establish a unique lifetime identity for a block replaced by another identical block at the same position; do not claim otherwise.

Entity references are rebound once per run, reserved distinctly, and checked on later steps by name/UUID (or object identity if UUID is absent). An absent or replaced entity cannot silently redirect the remainder of a procedure to another one.

A verified OPEN pins the actual window object. Later TRANSFER/CLOSE and window-change WAIT require the demonstrated window type/open state and that same object, not merely an equal numeric window ID. Inventory source slots are resolved from current item/count and current inventory boundaries. Container sources retain the item named in the evidence even if the original operation omitted it. Destination selection checks current metadata, NBT and capacity. Fixed container slot roles are checked where known. These are preconditions; the primitive/server still validates the actual transfer.

A binding precondition failure returns to the planner without executing the next step or adding a negative replay lesson. Explicit adapter failures still count; unconfirmed effects and spatial interruptions retain T04c semantics. New logs connect rebound steps to their original evidence IDs.

Environment matching keeps the exact Minecraft version, normalizes known dimension aliases and refuses unknown dimensions. Display filtering now happens before the 64-result limit. Indexed relevance search is still T06, not part of this task.

## Tests

The new suite uses real TaskExecutor, ExperienceMemory, WorldMemory and temporary SQLite databases with controlled game results. Its integration case produces real operation evidence for a fixture sequence, saves the sequence, closes/reopens the DB under another world ID, then replays at new coordinates with another window ID and inventory layout. It checks that original evidence stays unchanged and new effects/coordinates are recorded only in the destination world.

Additional cases cover same-species distinct targets, identity loss/replacement, concrete block scans, repeated and distinct block bindings, unloaded/occluded/changed blocks, relative routes, stale/replaced/closed windows, inventory counts/metadata/NBT/capacity, compatibility/listing, absent preconditions and genuine adapter failures.

Execution success must be read from the exact-head CI. Existing real Minecraft adapter smoke is regression only; it does not establish live learned-procedure replay or autonomous model learning.

## Limits deliberately kept explicit

- Relative geometry is translated, not rotated or adapted to new obstacles. No automatic navigation, material gathering or alternate action order is introduced.
- First binding of a pre-existing block is based on visible name and proximity. There is no inference of arbitrary semantic roles among otherwise identical stations.
- Evidence does not contain full demonstrated item NBT/components; this task checks compatibility between the CURRENT source and destination. It does not claim to reproduce a source-world enchanted/custom item identity.
- Legacy templates/evidence are not rewritten on read. Simple old relative/entity/inventory templates remain readable. A legacy CLOSE without window-context evidence refuses to close an open UI rather than guessing; historical data remains intact. Relationship information absent from a legacy template is not invented.
- Existing replay promotion/demotion rules remain unchanged (T05c).
- Real-model spontaneous SAVE (T05a live), live replay and portal/packet integration still require bounded acceptance runs. No user world or operational memory DB is touched, and no paid model is called.
- Local GitHub clone was attempted but DNS resolution failed; use the PR's actual CI as execution evidence, not an assertion of local test success.

## Next single task

After exact-head verification and integration: **T05c**, procedure re-evaluation/revision while preserving prior evidence and failures. Carry live T05a/T05b evaluation explicitly into bounded integration acceptance; do not label autonomous learning verified. T06 relevance/consolidation and T07 autonomous play remain separate. Prefer the latest task PR/checkpoint over the old T02 checkpoint in GAMEPLAY_TASKS.md.
