# T04a: world identity and spatial-memory boundaries

Updated: 2026-09-19. Base: `9227b0d26af718c85e88fca27c34c1615705af75` (T03c / PR #5 merged).

## Split and current checkpoint

T04a is split to keep each change independently verifiable:

- **T04a-1 (this change):** configured server identity, same-world restart, same-seed replacement world, identity-source failures and stopped-runtime generation rotation.
- **T04a-2 (next):** dimension-scoped observation/recall/live targets and transitions. The current world-memory implementation does NOT yet isolate dimensions. Do not mark the whole of T04a complete based on T04a-1.

Work branch: `fix/t04a1-world-server-identity`.
Status at document creation: IMPLEMENTED, pending exact-head CI. The associated PR records the latest tested SHA/run and integration state; never infer success from this document alone.
Changed implementation: `worldIdentity.ts`, `jevOrchestrator.ts`.
Tests: `worldIdentity.test.ts` (temporary marker files, real SQLite, runtime constructors/lifecycle paths; no network or paid model calls).

## Observed problems in the base

The runtime used the last persisted DB world ID when the marker could not be read, even after connection changes. It read the default local marker for remote servers too, and raw world tokens were not namespaced by server. With an explicit GAMEPLAY_WORLD_ID, nextGeneration rotated only the DB, so the same environment could restore the old map on process restart.

## Identity rules implemented here

The spatial namespace is a SHA-256-derived pair of **configured host/port and world token**. The seed is not an identity and is never used to decide whether an old map is current. Host spelling is trimmed/lowercased, but DNS/endpoint aliases are intentionally not guessed equivalent.

Identity sources, in order:

1. `GAMEPLAY_WORLD_ID`: an operator-supplied stable token. Set a new value when replacing that world. A token is configured evidence, not cryptographic proof of the remote world's identity.
2. `GAMEPLAY_WORLD_ID_FILE`: an explicitly configured marker. Missing, empty or unreadable explicit markers stop initialization rather than selecting the last DB world.
3. The repo-managed local `MC_DEV_DIR/server/world/.ai-world-id`, only for loopback connections whose port matches the local `server.properties` and whose `level-name` is `world`. Custom level directories or remote connections need an explicit identity/marker.
4. Without one of those, use `session_unconfirmed`, a fresh world namespace. Global experiences remain, but restart reuse of spatial coordinates is deliberately disabled because a restarted and replaced world cannot be distinguished.

Normal managed-server restarts keep the marker; the existing reset script removes the world directory and the start script creates a new marker. This change does not run those scripts or reset a user's world.

`world_identity_resolved` logs the scoped world ID, hashed endpoint ID, source and whether that source permits spatial reuse on restart. It does not dump credentials or the environment.

## Lifecycle behavior

At runtime creation, resolve identity before opening the DB. On `start()`, re-read identity to detect an externally replaced marker before reading/acting on the map. On explicit stopped-runtime `nextGeneration()`, adopt an externally changed token or atomically update an existing managed marker before switching the DB namespace. Never create a missing world directory for this operation.

An unchanged explicit `GAMEPLAY_WORLD_ID` cannot be silently rotated in the DB: `world_identity_explicit_rotation_required` is returned, with generation and active memory unchanged. Supply the replacement token before transitioning. Running transitions remain rejected.

## Upgrade compatibility and limitations

Older spatial records lack server provenance. This patch retains them in history and does not guess their server or migrate them into the current live map. Thus the **first upgrade requires re-observing local places**; global procedure/experience records are retained. The SQL memory schema and experience-learning behavior are unchanged. This is preferable to silently treating an old server's coordinates as current facts.

A copied world directory with an unchanged marker, a manually reused explicit token, or a proxy changing backends behind an identical endpoint cannot be automatically detected here. An operator must supply a distinct world token/marker. Marker+DB updates are not a distributed transaction; simultaneous external writers and process crashes during lifecycle transitions require separate testing. This change only addresses configured identity and normal local marker lifecycle.

These tests verify SQLite/runtime identity boundaries, not a live reconnect to every server implementation, no-LLM navigation behavior, dimension separation, or autonomous Hardcore survival. Existing Minecraft adapter smoke is a regression check, not proof of these larger claims.

## Next single task

After checking this PR's exact-head CI and merge state: **T04a-2 only**. Add dimension identity to world observations and recall, preserve old-world history/global learning, and test that same coordinates in overworld/nether/end do not overwrite each other or become each other's live targets. Review stale provenance and in-flight actions at dimension changes. Do not combine with T04b/T04c/T05/T06.
