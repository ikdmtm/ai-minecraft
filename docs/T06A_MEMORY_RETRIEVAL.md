# T06a — Bounded, read-only retrieval of old experience

Base: `4ec61f74062edd03e162e82535ffece704031ad7` (T05c / PR #13).
Status at authoring: implemented; exact-head CI/review pending. The PR records tested SHAs, actual results and integration. Do not infer a successful test from this document alone.

## Scope and model interface

`RECALL_MEMORY` accepts `memory_query` (1–8 literal terms, at most 256 characters) and an optional `memory_cursor`. The OpenAI structured-response path exposes these fields. It does not change provider selection, model settings or call a paid delegate. The existing choice-only JEV path still lacks this richer action interface; this PR does not claim feature parity.

The executor issues a read-only search across operation evidence, learned procedures and replay audit. `autonomy.memorySearch` carries the bounded result into the next executive and strategic inputs. Ordinary world capture does not issue a search. It is a transient response workspace, scoped to world/version/dimension, not another persistent fact store. Reopening the database preserves source records but not an old query response. Failed queries clear the old response.

The model chooses what to search and whether to use the result. A query does not save a procedure, replay operations, reinforce a sighting, increment any success/failure counter or infer a lesson. It also does not add historical coordinates to semantic targets. Existing execution/binding/environment checks remain authoritative.

A compatible procedure found outside the ordinary recent-64 procedure preview may be used as a presented revision parent. New SAVE evidence still must satisfy the existing consecutive verified recentExperience selection and database validation. Finding old unconfirmed evidence does not make it verified.

## Retrieval semantics and budgets

This first retrieval interface uses literal, case-insensitive, Unicode-normalized all-term matching. It is not embeddings/vector search, natural-language semantic matching, or a global relevance ranking. Use item/operation/error names, words occurring in the record, or source IDs. Results interleave evidence/procedure/replay streams, newest-first within each stream.

Each call reads at most 64 rows per table by indexed rowid range (192 rows total). Individual payload reads are capped at 65536 bytes, results at 12 hits and a 24000-byte JSON envelope budget. Long previews explicitly show truncation. Oversized and malformed rows are counted, not silently treated as searched.

`nextCursor` is a read-only continuation tied to the normalized query and current world/version/dimension. An empty partial page is NOT proof that no matching old experience exists. Continuing scans older pages; it neither restarts at the newest record nor drops unreturned matching rows when a hit/byte limit is reached. New appended records are excluded from an existing traversal and visible to a fresh search. Mutable procedure evaluations are read at query time; paging is not a transactionally frozen database snapshot.

No new search index or migration rewrites historical evidence. Work and response size are bounded per call, but searching a very deep unindexed history can require many pages/model decisions. A relevance index, multilingual semantic matching or background index-building would be performance enhancements, not evidence that this literal traversal has searched the entire corpus in one call. Those enhancements must not silently remove the current coverage/continuation guarantees.

## Provenance and safety boundaries

Every hit retains source kind, exact ID, row sequence, original world/version/dimension where recorded, source evidence IDs, and a historical-only flag. Same-world and environment-compatibility flags do not assert that the current physical preconditions hold. Procedure previews include parent/root/revision links, lifetime counts, confirmation streak and the model's revision interpretation. Replay previews retain source=runtime versus legacy_api, actual outcome and before/after assessment.

Source evidence/audit remains the authority. Previews and literal matches are not causal explanations. Search text and stored interpretations are data, not higher-priority instructions. Old source references are retained rather than converted to current entity/window IDs or live world facts.

## Verification planned

- Old failures outside recent-64, literal AND/case/Unicode matching, SQL-like input as data.
- Matching/no-match pages, cursors, new appends, wrong query/context, result and row budgets.
- Old compatible procedures beyond the display limit, parent/child lineage and replay failure audit.
- Read-only behavior, independent result snapshots, restart persistence, malformed/oversized row reporting.
- Actual TaskExecutor-generated evidence -> controlled model query -> real policy parser -> task -> SQLite -> next semantic/model input.
- Retrieved procedure selected for replay with live rebinding under controlled physical effects.
- Queried revision parent with new demonstrated evidence; historical search does not bypass SAVE evidence checks.
- Stop and changed-world boundaries; no automatic search or physical execution merely from reading.

New tests use temporary SQLite, real production classes, and controlled model transport/physical effects. Existing Minecraft smoke is adapter regression, not live spontaneous memory use. No user's operating DB/world or paid LLM is used. Local clone failed GitHub DNS resolution; exact-head GitHub CI is the execution evidence.

## Remaining scope / progress convention

The requested change is a general game-control interface + game specifications + persistent world-scoped and cross-world experience + learned procedure save/reuse/revision + relevant memory recall/consolidation. It is not an unlimited collection of Minecraft-specific scripted skills.

At this checkpoint, implementation is roughly four-fifths complete as an engineering estimate, not a measured percentage of gameplay success or time remaining:

| Workstream | State before final T06a CI |
| --- | --- |
| T01/T02: verification and run recording | Implemented and previously verified |
| T03: primitive adapter coverage | Implemented; existing real-server fixtures verified |
| T04: scoped persistence, transitions and outcome evidence | Implemented with controlled tests; live portal/concurrency acceptance remains |
| T05: save, replay binding, reevaluation and revision | Implemented with controlled path tests; spontaneous real-model/game learning remains unverified |
| T06a: relevant old experience retrieval | This PR; CI pending at authoring |
| T06b: non-destructive consolidation / revisable lesson candidates | Next single implementation task |
| T07: bounded autonomous run, provider configuration and integration evaluation | Not performed; findings may require focused fixes |

Implementation coverage and acceptance evidence are separate. The full change is not accepted for unattended autonomous play just because unit tests pass. Remaining live T05/portal checks belong in integration acceptance, not indefinitely expanding implementation tasks. A bounded first autonomous run should follow the remaining memory consolidation work using a compatible configured provider and an isolated test world/DB, without deleting the AI's original experience.

Next single implementation task after verified integration: **T06b only**. Preserve the distinctions between interpretations and source evidence, support correction, and do not delete source history on consolidation failure. Do not return to the obsolete T02 checkpoint in GAMEPLAY_TASKS.md.
