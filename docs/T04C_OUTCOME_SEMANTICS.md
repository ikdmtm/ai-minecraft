# T04c — operation outcomes and re-observation

Base: `4a2791f65279ac393c90c039fea0188de232ba01` (T04b/PR #9 merged).
Branch: `fix/t04c-outcome-evidence`.
Status at document creation: IMPLEMENTED, exact-head CI pending. Consult this task's PR for verified SHA, CI result and integration. Do not use the stale T02 checkpoint in GAMEPLAY_TASKS.md.

## Scope

One task only: distinguish operation completion, observed effects, idempotent postconditions, missing confirmation, timeout, explicit failure, interruption, and spatial re-observation. No new progression rules, LLM prompting, memory migration, skill generation policy, streaming or model settings.

Existing code treated every completed operation with `verified=false` as a failure in global operation statistics. A saved procedure also received a failed replay when an intermediate effect was unconfirmed. These are uncertainty, not evidence that the action cannot work.

## Rules

- Adapter `succeeded` means the adapter completed. It does not by itself verify the intended effect.
- `effect_observed` requires action-specific observations. A different item pickup is not the requested crafting output; a changing furnace output is not the requested source transfer; another entity's metadata/hurt is not this target's response.
- `already_satisfied` is an explicit confirmed postcondition for MOVE already at the requested cell, EQUIP already holding the selected item, and CLOSE already closed. It is not a claim of new world progress.
- `effect_unconfirmed` retains the original evidence, but changes neither success nor failure counters. LOOK or non-consuming USE with insufficient evidence remains uncertain.
- `condition_timeout` does not mean the awaited condition occurred or that waiting is an ineffective skill.
- Explicit adapter failure is still recorded as failure. Safety/stop/spatial interruption is preserved as interruption, without negative learning.
- An unconfirmed intermediate saved-procedure step interrupts replay for re-observation/replanning; no next step is executed and success/failure replay counts are unchanged. The underlying completed-but-unverified operation evidence is retained.
- No historical evidence, previous counters or saved procedures are deleted or reclassified by this change. Old incorrectly counted outcomes are not silently 'repaired'.

`outcome` and `assessmentReason` are added inside the existing evidence `effect` JSON. Original evidence format/readers and SQL tables remain compatible. Every new confirmed/failed global statistic includes its evidence ID. Unconfirmed cases remain available in the append-only evidence store rather than disappearing because they were excluded from binary statistics.

## Observation boundaries

INTERACT_ENTITY compares immutable snapshots of the selected target's identity and metadata. Target disappearance/replacement is not automatically proof of an interaction or a kill. ATTACK observes target hurt and does not label that a kill.

PLACE only confirms a loaded air target becoming the requested block name. BREAK requires a loaded target becoming air. Unloaded chunks are not successful destruction/placement. Transforming placements (seeds -> crops, wall variants) and a broken block immediately replaced by fluid may remain unconfirmed pending specification-aware evidence. This conservatism must not produce a false negative lesson.

CRAFT confirms the requested output count increasing; USE confirms the selected item count decreasing. These observations are still correlations within the operation interval, not a universal proof of causality in the presence of unrelated server activity. No new claim is made about all server acknowledgement races. Inventory/metadata snapshots are not raw packet receipts.

Current SemanticWorldModel already keeps remembered locations separate from current entity/resource targets and does not reinforce them merely on arrival. Tests protect that behavior: arrival and unloaded/occluded blocks leave stored observation timestamps/counts unchanged; an actual matching entity or visible resource observation updates them. Not seeing an animal is not sufficient evidence that an entire area is empty. Full absence scans, tracking mobile entities across cells, and related-memory search are not implemented here.

## Verification

New `outcomeEvidence.test.ts` uses actual TaskExecutor/WorldMemory/ExperienceMemory/SemanticWorldModel and temporary real SQLite, with physical operation results controlled by fixtures. It tests binary statistics, evidence retention, confirmed vs unrelated changes, timeout/interruption, learned replay boundaries and location re-observation. Fixture demonstrations and replay counters are not autonomous learning.

Run full typecheck/build/Jest/export and existing Minecraft 1.21.4 smoke on the exact PR head. Existing smoke is an adapter regression, not a live autonomous or portal-transition benchmark. No paid LLM calls or user world/operational DB access.

## Checkpoint

Task ID: T04c
Changed files: src/gameplay/operationEvidence.ts, src/gameplay/taskExecutor.ts, src/gameplay/outcomeEvidence.test.ts, docs/T04C_OUTCOME_SEMANTICS.md
Status: IMPLEMENTED; latest exact-head CI and merge result are recorded in the PR.
Next single task after verification/integration: T05a, model-selected SAVE_PROCEDURE using actual evidence IDs. Separate controlled model-response tests from any paid-model autonomous run; do not equate API storage success with spontaneous learning.
Remaining acceptance items: live portal/readiness integration and internal client packet continuations from T04a; T05b/c procedure reuse/revision; T06 retrieval/consolidation; T07 recorded autonomous play. No unattended-run acceptance is implied by this task.
