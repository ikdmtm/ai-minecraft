# T06b — Non-destructive consolidation and revisable interpretations

Base: `2f689e369a5fc70a430d4a04dddfb1739b47a168` (T06a / PR #14).
Status at authoring: implemented, verification pending. The corresponding PR records exact tested head, CI logs and integration. Do not infer success from this document alone.

## Scope

Finish the remaining bounded memory feature: the agent may group actually presented operation evidence into a compact summary or tentative lesson, then correct or withdraw that interpretation. The original evidence, learned procedure templates, replay journal and evaluation counters are not rewritten or deleted. The agent, not a deterministic gameplay script, chooses what to summarize and what conclusions to propose.

This is an explicit in-loop action, not a new paid background model, scheduler, automatic sleep cycle, vector index or arbitrary code generator. Semantic clustering, memory-wide automatic deduplication and truth-verification of natural-language claims are not included. It is an external memory mechanism, not model-weight learning.

## Interface

The existing structured-response policy can choose `CONSOLIDATE_MEMORY` with:

- `memory_note`: kind (`summary` or `lesson`), title (1–120 chars), content (1–2000 chars), state (`candidate` or `withdrawn`), parentId (null for a new interpretation).
- `evidence_ids`: 1–12 distinct IDs of original operation evidence presented in recentExperience or the current memorySearch evidence hits.
- `reason`: 1–300 chars describing the interpretation or change.

All notes carry interpretationOnly=true. There is no verified/fact state. Failures, interruptions and unconfirmed effects are legitimate sources for reflection, but remain exactly those outcomes. Notes cannot be cited instead of source operation evidence, become executable skills, or populate live navigation targets. The stored originating world/version/dimension of each source is retained, with its sequence, status, verification flag and payload hash. Note world/version/dimension is authoring context, not an applicability guarantee.

Parent selection must refer to a currently presented note revision. The database separately checks that it is still the current head. A correction reinterpreting the same evidence is allowed; identical text/state/source corrections are not new evidence. Withdrawal requires a parent. A withdrawn chain may later gain a new candidate revision with an explanation. No automatic acceptance or inference of causality occurs.

## Storage, retries and history

Additive table `autonomy_memory_notes` and indexes only. Every note revision is INSERT-only and linked by rootId/parentId/revision. There is one child per parent, and the latest head is found with an indexed query. Saving is transactional; an insertion failure leaves the previous head and all raw records intact. Exact normalized note+evidence-set+reason retries return the same record even after restart; this is exact deduplication, not semantic equivalence detection. Different interpretations may coexist as separate roots.

Original evidence is never replaced with its summary. Sources are bounded, validated by actual ID and retain original outcome/context metadata and a SHA-256 digest of their saved payload. A digest is a traceability aid, not proof of truth or protection from hostile disk tampering.

## Retrieval and correction freshness

T06a's bounded, read-only search now includes a fourth kind, `note`. Each call scans at most 64 payloads/kind (256 total), with the existing 12-hit / 24000-byte response budget and cumulative skipped-row counters. Note hits perform bounded indexed latest-head lookups and identify currentRevisionId/currentState/isCurrent, even when only the old text matches the query. Candidate is still an interpretation. Superseded and withdrawn content is retained as history, not current advice.

Continuation cursor format advances to v2 and remains connection-signed; restart starts a fresh traversal. Existing original-record search semantics remain intact. The search workspace is cleared after a successful save, and a cached note result is invalidated if its current revision changes through another connection. The saved note ID is recorded in task output/events for explicit recall. No automatic archive search, world operation or raw evidence append is triggered by consolidation.

The model must retrieve original evidence it wants to cite, not merely trust a prior summary. Searching a source evidence ID can retrieve the original and notes that cite it. If a parent and needed old sources are not in the bounded current input, retrieve an appropriate page first; this implementation does not inject the whole archive into every decision.

## Verification scope

New tests use actual policy serialization/parsing, TaskExecutor, effect assessment, SemanticWorldModel, ExperienceMemory and temporary SQLite. Physical block effects and model transport are controlled. Test append-only source/counter preservation, all source outcomes, cross-world provenance, correction/withdrawal/reconsideration, restart, exact retries, stale edits, insertion failure, malformed/oversized/missing sources, bounded history/search, cached correction invalidation, presented-ID validation and stop/world/dimension boundaries.

Existing full regression tests, specification export and Minecraft 1.21.4 adapter smoke must pass at the final PR head. Smoke remains basic-adapter regression, not spontaneous model consolidation or learned behavior. A local git access attempt failed GitHub DNS resolution; do not claim local test execution. No operational world/DB or paid inference is used.

## Completion and next scope

T06b supplies the last planned core memory feature for the structured-response path, with explicit limits. It does not solve the existing JEV choice-only feature gap, prove intelligent autonomous gameplay, or validate live portal/internal packet cancellation. Those remain integration criteria, not reasons to keep adding unrelated gameplay scripts.

After verified integration, next single task is **T07a: provider-capability preflight and a bounded, isolated integration evaluation**. Confirm the configured policy exposes the needed operation/memory actions, avoid an unannounced provider switch, and use a disposable world/DB rather than the user's operating memory. First inspect available execution prerequisites; record blockers honestly rather than running paid calls or asking the user to start an unverified unattended stream. Carry live learned replay and portal/concurrency checks into the explicit acceptance plan. Do not reset the AI's existing experience.
