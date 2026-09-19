# T07a — Provider preflight and isolated, bounded evaluation

Base: `0a7dc7f0c85f9192f12291d34bfbcbae3a43ebe8` (T06b/PR #15).
Status at authoring: implemented, exact-head CI pending. Use the corresponding PR's final SHAs and logs for verification; this document alone is not a successful test result.

## Scope

The major requested control/knowledge/memory interfaces are implemented. T07a provides the entry point for integration evaluation, not another Minecraft progression script and not a claim of unattended gameplay readiness. Normal `start:gameplay`, provider selection and model defaults are unchanged. No model is silently substituted.

Three distinct states must remain distinguishable:

1. Static application-interface compatibility: supported task shapes, configured credential presence and explicit errors. No network or DB writes.
2. Isolated launcher verification: actual Java server, actual Minecraft client, copied memory, recording and cleanup, with an explicitly labeled repository process fixture and no model.
3. Live configured runtime evaluation: actual model decisions and learned-memory use. This remains a separate acceptance item even when the first two pass.

## Commands

```sh
npm run check:gameplay
npm run eval:gameplay -- --prepare
# Explicit opt-in: this starts the configured model runtime and may incur API charges.
npm run eval:gameplay -- --run --seconds=60
```

`check:gameplay` uses the actual ExecutivePolicy constructor to resolve auto/explicit provider selection and reports task-interface support. A contract test compares supported task lists against the real requests assembled for both adapters, using mocked transport. The current JEV path exposes only EXECUTE_AFFORDANCE/WAIT; it therefore fails the full-autonomy evaluation preflight instead of appearing to support saving/replaying/searching/consolidating memory. This is an adapter limitation, not a claim about the remote model's general capabilities. Invalid provider spelling is rejected instead of silently falling back. Missing/placeholder credentials are reported without printing their values. Strategic planning still requires its configured credential.

A green static check does NOT verify credentials, model existence/access, API schema acceptance, reasoning settings, rate limits, billing, Java installation or Minecraft protocol compatibility. `remoteAuthVerified` and `remoteModelVerified` remain false. The operator's local .env has not been read by a GitHub-only code change.

## Preparation and isolation

The preparation command is the default; `--run` must be supplied explicitly. Both create a fresh owned directory beneath `data/gameplay-evaluations/eval-*`. There is no reset, deletion, automatic merge-back, or resume-existing-directory path. Each invocation has a unique world identity even though this first repeatable fixture uses the configured seed 7.

The existing distribution is read from `${MC_DEV_DIR:-.minecraft-dev}/server/server.jar`. The JAR is copied, not linked, and its hash recorded. An already accepted `eula=true` in that source directory is required; the evaluator does not newly accept the terms. The operational world's blocks, properties, identity marker and PID are never modified or copied into the new world.

Existing `DB_PATH` memory is copied through SQLite's read-only backup API, including committed WAL data. Evaluation writes only to the copy. Missing source memory is labeled absent, a corrupt/unreadable source aborts rather than silently becoming empty. `--fresh-memory` is an explicit empty-memory comparison, never deletion of the original. All evaluation output, the world, copied experience and diagnostics remain in the owned directory. Retention/disk cleanup is an operator decision, not an automatic erasure of experience.

The child gets explicit new world ID/marker, test username, isolated DB/knowledge/log paths, loopback host and a separately allocated port. Viewer/autolaunch is disabled. Model/provider settings and necessary runtime credentials are inherited, not changed or written to a config file. Java and the knowledge-export subprocess receive only allowlisted system variables, not model credentials. Exported knowledge comes from the same copied JAR. Actual connected server/version facts remain runtime observations.

## Bounded execution

The opt-in launcher runs on POSIX/WSL, starts its own Java child with loopback-only networking and RCON disabled, then starts the recorded gameplay child only after that server reports readiness. A port-race failure aborts; it never falls back to a pre-existing endpoint. Initial server readiness is bounded to 90 seconds, knowledge export to 30 seconds. The gameplay-child wall-time bound defaults to 60 seconds, configurable from 15 to 300 seconds. It includes runtime startup, not guaranteed active gameplay time.

`RunRecorder` gains optional duration, shutdown-grace and AbortSignal controls. Existing callers without limits retain normal behavior. The bound sends SIGTERM and allows up to 10 seconds for cleanup before killing the owned process group. Java is stopped in a finally block using its owned stdin, then its owned group if necessary; operational PID files are not consulted. The report distinguishes preparation failure, duration limit, cancellation, forced stop, unconfirmed cleanup and ordinary child shutdown. Exit 124 means the duration limit was reached, NOT a gameplay success. All evaluation reports start and remain `accepted=false`; acceptance requires analysis of the actual journal.

This wall-time bound is not a hard monetary/token quota. In-flight API requests may already have incurred charges. Native Windows group cleanup, parent SIGKILL/power-loss cleanup, actual live model latency/cancellation and Minecraft internal packet races are not guaranteed by the process-fixture tests.

## Verification design

Unit/contract tests cover no-network static selection, no silent provider switch, malformed inputs, secret redaction, interface drift, isolated destinations, same-seed/different-world identity, committed memory copying, explicit fresh comparisons, broken sources, EULA requirements and opt-in.

Real child-process tests exercise cooperative and forced duration stops, abort before spawn, active cancellation, next-run independence and listener cleanup. No model is invoked.

The existing `test:gameplay-smoke` entry now runs the old primitive-adapter fixture followed by `scripts/evaluation-smoke.ts`. The latter prepares a new server using the downloaded fixture JAR and a temporary sentinel DB. It launches an explicitly labeled repository process, connects a real Mineflayer client, writes only the copied DB, verifies the original sentinel, checks the run journal and verifies owned-server cleanup. It never instantiates a model policy/planner; fixture mode is persisted in both evaluation and run manifests and cannot be selected through the public evaluation CLI. `ISOLATED_EVALUATION_LAUNCHER_PASSED` proves launcher wiring, not autonomous gameplay, policy-schema acceptance, spontaneous learning or memory usefulness.

Local repository clone was attempted and failed GitHub DNS resolution. Actual test-execution evidence for this task is the final GitHub CI run, not a claimed local test. No operational world/DB or paid model request is used in these checks.

## Next bounded task

After exact-head verification/integration, **T07b: first short evaluation using the real configured runtime and a compatible provider**, preserving original memory. Review actual ready/decision/error/evidence/termination events first; address the first demonstrated blocker rather than adding unrelated features. Verify remote API compatibility before interpreting a stalled or empty run as poor game reasoning. Live spontaneous SAVE/RUN/RECALL/CONSOLIDATE, actual portal/internal-packet transitions and longer survival remain separately reported acceptance evidence.

Do not report a repository fixture as a live model run. Do not return to obsolete T02 checkpoints in GAMEPLAY_TASKS.md. This document and its PR are the current resumption point.
