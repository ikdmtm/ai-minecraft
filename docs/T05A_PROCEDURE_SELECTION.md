# T05a — model-selected, evidence-backed procedure saving

## Scope and checkpoint

Base: `681b614eb35de7fc75b32cd917f098f119f259d7` (T04c / PR #10).
Work branch: `test/t05a-procedure-selection`.
Status at document creation: implementation and controlled tests added; inspect the associated PR's exact-head CI before calling the automated portion verified.

This task checks the existing path:

`TaskExecutor operation -> verified ExperienceMemory evidence -> SemanticWorldModel snapshot -> ExecutivePolicy request -> model SAVE_PROCEDURE choice -> database validation -> saved candidate -> subsequent snapshot / restart`.

This is not a curriculum or automatic skill generator. Valid evidence alone does not trigger a save. The model chooses whether to save, the name, and the evidence sequence. A save is a candidate, not proof that a procedure generalizes or has been replayed successfully.

## Changes

- `procedureSaveSelection.ts` validates the SAVE response at the policy boundary. The name and 2–12 distinct IDs must be well formed; all selected IDs must have appeared in the presented `autonomy.recentExperience`; they must describe verified, consecutive successful operations from one session/world/version/dimension. There is no fallback that invents, substitutes, reorders or automatically chooses evidence.
- `ExperienceMemory.save` remains the final database authority and still validates stored evidence. No database schema or historical records are changed.
- `executivePolicy.ts` records the requested name and evidence IDs and applies that validation. Invalid selections use the existing explicit error/fallback path and cannot save.
- `taskExecutor.ts` logs `procedure_saved` with the actual stored ID/name/status/evidence IDs. An idempotent SAVE reports the existing status rather than always saying `candidate`; it does not reset counters or rename the existing record.
- `procedureSelection.test.ts` exercises the real policy parser, snapshot, executor, effect assessment and SQLite classes. Transport and physical block changes are controlled. Positive demonstrations generate evidence through TaskExecutor rather than fabricating successful SAVE API results.

## Automated acceptance

1. The request includes the actual verified trace IDs and SAVE schema fields. Both supported response text envelopes lead through the real parser and executor to a persisted candidate.
2. Saving does not replay the procedure, alter original evidence, or increment replay counters. The next world snapshot and a reopened database expose the candidate and its evidence links.
3. A model choosing WAIT does not cause automatic saving.
4. Invalid names, missing/malformed/duplicate/invented/unpresented IDs, reversed or gapped sequences, cross-context traces, failed/interrupted/unconfirmed evidence, malformed/refused/incomplete responses and transport failures cannot save.
5. Bypassing the policy still meets the database's independent evidence guard.
6. Duplicate saving preserves actual persisted verification state and counters and reports them correctly. Synthetic replay counters in this test are fixture setup, not successful live skill replay.
7. A delayed SAVE response cannot write after TaskExecutor.stop(). Spatial epoch/portal behavior remains the separately documented T04a responsibility.

The suite replaces global fetch and uses dummy strings, not credentials. It does not start Minecraft or issue paid requests. Run it through `npm test -- --runTestsByPath src/gameplay/procedureSelection.test.ts`; the normal full CI also includes it.

## Provider boundary

The existing OpenAI structured-response path exposes SAVE_PROCEDURE and explicit operations. The current JEV choice-only path exposes only EXECUTE_AFFORDANCE and WAIT and has no SAVE arguments. A test records this limitation rather than claiming provider parity or silently routing a JEV decision to another paid model. This task does not change provider or model configuration.

## What is NOT verified by these tests

- A real model deciding on its own that a demonstration is worth saving.
- The usefulness or novelty of the named skill, generalization to another world, or the quality of its replay.
- Actual Minecraft packet/cancellation behavior during portal transitions.
- Related historical evidence retrieval or memory consolidation.

The existing Minecraft server smoke is an adapter regression, not a model-learning experiment. Automated success must not be described as spontaneous learning.

## Remaining live T05a evaluation

Keep this explicitly open until the model and Minecraft are actually run together in an isolated, bounded evaluation with a separate database and recorded source/model/world settings. Preserve whether a SAVE was spontaneous under the normal objective or directly requested by an evaluation prompt; neither a fixed response nor a forced SAVE proves spontaneous learning. The evidence chain must show original operation outcomes, exact IDs sent to the model, returned IDs/name, persisted candidate ID and the subsequent snapshot. No SAVE within the evaluation budget is a valid negative observation, not permission to hard-code one or relabel a fixture.

No paid-model environment is exercised in this task; no user's operational world or memory is modified. Do not request unattended production play to fill this gap.

## Next bounded task

After exact-head CI and integration of the automated T05a portion: T05b, late binding and environment compatibility of saved steps. Carry the unexecuted live T05a evaluation into the bounded model/game acceptance run; do not mark it done or block every code-only task on it. T05c, T06 and T07 remain separate. Use this document and its PR for the current checkpoint instead of the stale T02 checkpoint in GAMEPLAY_TASKS.md.
