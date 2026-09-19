# T04a-2b: runtime transition leases

Base: `5fa02d7e2f60c0d2e1c1624152846072065eaddf` (PR #7).
Branch: `fix/t04a2b-runtime-transitions`.
Status at creation: implementation/test authored; exact-head CI pending. The PR records verification and integration.

## Scope

Finish the runtime side of the T04a-2a dimension-memory change. This is not a new gameplay plan, memory schema, recipe selection rule or hand-authored survival skill. Persistent world/dimension maps, global evidence and learned procedures are preserved.

`SpatialRuntimeContext` owns a monotonic, process-local transition epoch. Raw client login/respawn invalidates the lease before ordinary packet listeners update Mineflayer's world. The same-dimension respawn and A -> B -> A cases therefore invalidate old work even when the final dimension name and semantic revision match the original observation. Fallback bot respawn events are used only when raw prepend listeners are unavailable.

Readiness requires a known dimension, a spawn event, a fresh forced position and a readable current column. Waiting time never implies readiness. Runtime observation getters, strategy requests and Executive dispatch are gated until ready; startup has a bounded readiness deadline. The existing 1.21.4 player_loaded handshake remains a separate protocol concern and is not replaced.

On invalidation, the runtime stops the safety loop, aborts pending strategy requests, interrupts the task and calls the primitive stop/release path. Transient physical provenance and spatial goal/subgoals are cleared; persistent experience is not. Safety and planning resume after readiness. Each Executive loop captures its owning runtime objects and lease: an old response cannot act on a new connection after stop/start. Strategy also checks ownership after response-body decoding and does not reschedule an obsolete loop.

Each task/operation captures its lease and original task ID. A canceled operation cannot continue to the next learned-procedure step or save a destination placement. Its late finalizer does not query destination blocks/inventory before readiness, does not complete a newer task, and records interrupted evidence under the source context rather than a negative learning example.

## Verification

`spatialRuntimeContext.test.ts` exercises actual context/task/strategy/orchestrator classes with controlled packet events and temporary real SQLite. It also exercises the real SkillExecutor WAIT stop path and the cooperative USE adapter's delayed equip boundary. Paid model calls and the user's worlds/DBs are not used. Tests cover readiness, raw-listener ordering, same-dimension and ABA changes, disconnect cleanup, gated observations/operations, stale Executive/strategy replies, old finalizer ownership, and no continued learned step after a transition.

Existing Minecraft 1.21.4 adapter smoke is a regression check. It does not become a live portal lifecycle test just because these mocked transition tests pass.

## Explicit guarantee boundary

Cancellation releases controller-owned movement/dig/use controls synchronously and prevents subsequent cooperative adapter steps and learned-procedure steps. It cannot retract packets already accepted by the server. Mineflayer's internal multi-packet inventory/craft operations do not expose complete cancellation; this change does NOT prove all pending internal library packet continuations are canceled. Live portal crossings during those operations and protocol-level packet ownership remain a required integration check before unattended play, not a claim of this PR. No raw global network-write monkey patch is introduced.

A column being readable is the currently implemented spawn gate, not proof all inventory/entities and surrounding chunks are synchronized. Live-server transition acceptance must verify that gate against the pinned client. Debug bot access remains an explicit escape hatch, not part of automated observation getters.

## Next checkpoint

Check the associated PR's exact-head CI and merge state. After this bounded runtime change, proceed with the remaining T04 memory-lifecycle tests recorded in GAMEPLAY_TASKS.md; include live dimension/respawn acceptance before declaring the transition feature production-ready. Then T05 learned-procedure reuse, T06 retrieval/consolidation and T07 autonomous gameplay evaluation. Do not infer that all implementation or unattended Hardcore readiness is complete from unit-test totals.
