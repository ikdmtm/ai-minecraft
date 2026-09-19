# T05c — Re-evaluation and evidence-backed revisions

Base: `abf29a868d811d0fc2c440f8465659c352eef287` (T05b / PR #12).
Status at authoring: implemented; exact-head CI and review pending. The PR records the final tested SHA, run, logs and integration status. Do not infer completion from this document alone.

## Scope

A past failure must not permanently bar a procedure from being evaluated again. A changed method must not erase its parent or inherit a parent's confidence. Whether to retry, change a method, or do something else remains a model decision. No survival recipe, automated retry loop, automatic skill creation, model switch or paid delegation is introduced.

## Evaluation

Lifetime `successes` and `failures` are retained. On a new assessed replay, `confirmationStreak` increments for confirmed completion and resets on an actual failed operation. Two confirmed completions since the latest failure set `status=verified`; the next failure returns it to `candidate`. This is a deliberately small evidence threshold inherited from the prior two-success rule, not a statistical guarantee of generality, usefulness, safety, or long-term survival.

Interrupted, missing-binding and unconfirmed attempts are journaled but do not change lifetime counters, the streak, or the stored procedure payload. They do not count as successful repetitions either. Already-satisfied postconditions remain the T04c semantics: a verified replay means step postconditions were verified, not necessarily new world progress.

Old payloads are not rewritten on opening the database. If an old record has failures and no streak, its old ordering is unknown; a new success starts a fresh streak at one rather than inventing a clean recent history. All lifetime totals remain intact.

## Replay journal

`autonomy_procedure_replays` is an additive SQLite table with an index on procedure ID and sequence. There is no DELETE, backfill, relabeling, or reset of historical evidence. A summary update and its replay journal entry commit atomically; a failed journal insertion rolls the summary back. Exact retries of one attempt ID are idempotent; conflicting reports are rejected.

The runtime captures one attempt ID and its original task/world/version/dimension before executing. The operation finalizer supplies exact newly generated evidence IDs to that attempt; it does not query a last-N buffer and guess which evidence belongs to a run. Success requires a complete verified step sequence. Actual failures require a failed operation trace. Unconfirmed and interrupted prefixes remain inspectable, including stop/world-change evidence.

Each replay records before/after assessment, outcome, time, original context and evidence IDs. `replayHistory(procedureId, limit, offset)` pages the audit without deleting old failures. The original boolean `recordReplay` API remains compatible for older callers/tests and labels its entries `legacy_api`, with no claim of runtime evidence. The current TaskExecutor uses only `recordReplayAttempt`.

A process dying before its final replay record can leave operation evidence without a completed replay assessment. It must not be reconstructed as success. Recovery of unfinished attempts is not added here.

## Explicit revisions

Use the existing structured-response `SAVE_PROCEDURE` task with:

- `procedure_id`: the presented parent ID, or null for an ordinary new procedure;
- `procedure_name`: the proposed child name;
- `evidence_ids`: 2–12 fresh, verified, consecutive demonstrations from one context;
- `reason`: the model's interpretation of the proposed change, not a proven causal lesson.

Policy validation requires the selected parent and evidence to have been presented. SQLite validation remains authoritative even when callers bypass policy validation. The new demonstration must match the parent's Minecraft version and normalized dimension. It may come from another world/session, but its own steps must form one contiguous demonstration.

A child stores parent ID, root ID, revision number and reason, starts as a candidate with zero replay counts, and references its own source evidence. Parent templates, evidence, audit and counters are unchanged. The parent remains selectable; no automatic replacement or retirement occurs. Repeated requests for the same parent/evidence return the same child without resetting name/status/counters. Unchanged templates or parent-evidence reuse are rejected as revisions; re-evaluate the original instead. Generic cross-procedure deduplication belongs to T06, not this change.

The compact semantic procedure preview still presents IDs, names, status, lifetime counters, steps and evidence IDs. Full lineage/streak/audit is persisted and recorded in task logs; relevance-based retrieval and richer memory presentation remain T06. The existing JEV choice-only path cannot choose SAVE/REVISION; structured-response tests cover the OpenAI path, without changing provider/model settings or claiming parity.

## Planned verification

Use actual TaskExecutor, operation assessment, ExperienceMemory, WorldMemory, SemanticWorldModel, policy parsing and temporary SQLite. Control physical block results and model transport; no paid model, operational DB or user world. Check:

- verified -> failed -> candidate -> two new verified replays -> verified, lifetime failure retained;
- unconfirmed/partial/binding/safety/stop/world/dimension boundaries without negative learning;
- exact attempt evidence, replay journal persistence, idempotence and transactional rollback;
- unchanged legacy payloads and explicitly labeled compatibility reports;
- demonstrated child/grandchild lineage, parent immutability, idempotent re-save;
- invalid/missing/unchanged/incompatible/unconfirmed revision rejection;
- actual model-request serialization -> controlled selection -> parser -> executor -> child storage.

Existing full tests, specification export and Minecraft 1.21.4 smoke must also pass. Existing smoke is adapter regression, not live learned-procedure replay or spontaneous model revision. A local clone was attempted but GitHub DNS resolution failed; do not claim local execution. Exact-head GitHub CI is the execution evidence.

## Next single task

After verified integration: **T06a — bounded retrieval of relevant old evidence, failures and learned procedures, with provenance**. Include lineage and replay journal in the retrieval design. Keep T06b consolidation separate. Live T05a/b/c model learning/replay/revision, live portal/readiness and T07 autonomous Hardcore acceptance remain outstanding. No user-side startup requested by this task.
