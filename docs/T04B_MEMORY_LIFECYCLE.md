# T04b — cross-process experience and procedure retention

Base: `4d946374eb6c9a1255416544594d1d66fe51b9f9` (PR #8 merged).
Work branch: `test/t04b-memory-lifecycle`.
Status at creation: implementation of the test fixture is complete; exact-head CI and integration are recorded in the associated PR. Do not mark verification complete from this document alone.

## Scope chosen before verification

Test existing persistence, not another gameplay architecture rewrite. The original requirement is that the same AI carries its experience into subsequent worlds without importing the old world's coordinates into the current map. A persisted procedure must retain its evidence IDs and the original world/version/dimension/session of those records.

Changes are a child-process fixture, its Jest tests, and this document. No runtime control, SQL schema, recipe policy, model selection, commentary, or learning algorithm is changed unless a test demonstrates a defect that belongs to this scope.

## Test arrangement

`scripts/fixtures/gameplay-memory-lifecycle.ts` is restricted to a parent test IPC connection and a dedicated system temporary directory. It does not call runtime.start(), start Minecraft, or request any LLM. Each launch uses a new Node process with `--import tsx`, the actual CognitiveOrchestrator constructor/world-rotation/shutdown methods, and its actual WorldMemory and ExperienceMemory SQLite connections. Only test credentials/settings are passed; no operational DB or world files are accessed.

The fixture deliberately creates synthetic successful, failed, interrupted and unconfirmed operation evidence. Candidate/verified/replayed-failure procedures are saved from that evidence through the existing APIs. Replay counters are explicit fixture data, not evidence of an AI independently learning or successfully replaying a procedure.

Tests compare decoded fields AND serialized evidence/procedure payloads to detect accidental overwrites, counter resets, ID changes, or loss of historical provenance.

## Boundary cases

1. Graceful close and a separate-process reopen retain global facts, procedure states/counters and all source evidence.
2. A new session appends a higher sequence without rewriting old records; aggregate counters accumulate.
3. Saving the same source evidence after restart is idempotent and cannot reset a verified procedure.
4. Actual nextGeneration and reopen retain global data/history while current spatial recall excludes the old world.
5. A new runtime in world B can later reopen A and reuse A's map; neither switch erases experience.
6. SIGTERM and SIGKILL after an IPC acknowledgement of committed writes preserve those writes without close hooks.
7. SIGKILL during a deliberately uncommitted SQLite transaction rolls back that transaction without replacing committed procedures or inserting its partial evidence.
8. Exceeding the bounded recent-evidence list does not delete old evidence referenced by a saved procedure.
9. Actual runtime destroy/stop, optionally followed by world rotation, allows an already-running TaskExecutor finalizer to record an interruption against the source world. The physical operation is mocked. Reopen retains that evidence and does not add a negative lesson or destination placement.

## Guarantees not claimed

- Process-kill recovery tests are not power-loss/disk-failure/host-crash proofs. Operations killed before committing are not magically reconstructed.
- The rollback test holds an explicit SQL transaction to test recovery; append/save/aggregate updates are not claimed to form one atomic multi-table transaction.
- Runtime lifecycle tests do not establish Minecraft portal readiness, every client packet cancellation, or long-term Hardcore survival.
- Bounded retrieval retaining a record is different from finding the most relevant record. T06 still owns relevance retrieval and memory consolidation.
- T05 owns AI selection of SAVE_PROCEDURE, re-binding/replay and revision; fixture-generated procedures do not validate autonomous skill learning.

## Verification procedure

Run `npm run lint`, `npm run build`, `npm test -- --runTestsByPath src/gameplay/memoryLifecycle.test.ts` (focused), the full `npm test`, and the existing specification-export and disposable Minecraft adapter smoke through Gameplay CI. Record the exact head/base/tested merge, CI run and actual test totals in the PR. A pending or older run is not verification of a new head.

The working container could not resolve github.com for a clone; CI is the execution environment for this task. This does not imply a GitHub connector access failure.

## Next single task

After exact-head verification and integration: **T04c only**, classification of failure/interruption/no observed effect/re-observation, without treating arrival at a remembered location as renewed proof that the remembered resource exists. Do not combine T05/T06/T07.

T04a's live transition/portal and internal packet-continuation acceptance checks remain explicit before unattended operation. Normal autonomous play has not been accepted merely because persistence tests pass. Earlier T01–T03 and T04a changes are already integrated in PRs #1–#8; do not restart from the obsolete T02 checkpoint in GAMEPLAY_TASKS.md.
