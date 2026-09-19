# One-touch launcher integration before T07b

## Operator entrypoint

For the first short real-runtime trial, run from the WSL repository:

```bash
bash run.sh eval
```

This uses the existing `run.sh` bootstrap and `scripts/dev-one-touch.sh` updater. No separate git pull, npm install, or standalone check is required. Existing bootstrap versions already forward the mode; after a successful pull their existing re-exec passes it to the updated launcher. A failed fetch/pull/stash restore stops before gameplay.

The flow is sync -> dependencies -> existing local credential setup when needed -> static provider check -> isolated 60-second evaluation. The time bound starts with the gameplay child, so server preparation is outside it. This is not a monetary/token cap, and configured model requests may incur charges. Java, Python and a previously prepared server distribution with an existing EULA acceptance are prerequisites of the evaluator. A missing source JAR/EULA is reported rather than resetting the operational server to create one.

The evaluator uses a new world/port and a SQLite backup of the existing memory. It does not reset, start, stop or overwrite the operational world, DB or launcher PID. Test experience remains in the isolated copy; it is not merged back. The existing evaluator disables automatic viewer startup. This is a logged diagnostic trial, not acceptance of unattended play.

At completion or failure the terminal identifies the existing single shareable log:

```text
logs/gameplay/run-<timestamp>.log
logs/gameplay/latest.log  (symlink to the latest run)
```

Share that log, not `.env`, credentials, or a copy of the entire repository. The underlying evaluation directory and recorded runtime events are included in the terminal log. Detailed server/DB diagnostics remain in the separate evaluation directory when needed for follow-up diagnosis.

## Provider handling

No longer rewrite `LLM_PROVIDER` or `POLICY_PROVIDER` during launcher startup. Keep existing environment/configured models. The normal credential setup is retained for missing credentials; check-only mode does not create `.env` or prompt for them.

A failed static check prevents world/server/runtime operations. In `eval` mode only, if the sole blocker is the implemented JEV adapter's missing autonomy tasks and the OpenAI path passes the same static check, offer explicit `[y/N]` consent to use the configured OpenAI models for this trial. `y` or `Y` sets only the child-process environment; `.env` and later launches are unchanged. Decline, empty input and EOF stop. Invalid provider, missing credentials and unrelated errors are never silently converted to a different provider.

Static readiness is not remote authentication, model availability or acceptance of the API request schema. The first real run remains T07b evidence, including failures. No JEV model capability claim is made; the restriction is in the current application adapter.

## Existing commands

- `bash run.sh`: retains fixed-seed fresh-world reset and normal launch, now only after successful preflight. It is NOT the safe first isolated trial.
- `bash run.sh continue`: retains the world and launches normally after preflight.
- `bash run.sh check`: update/dependencies/static check only; no world/runtime/DB operations, `.env` creation or provider-change prompt. The updater itself still accesses GitHub and can update source/dependencies/logs.
- `bash run.sh eval`: isolated bounded trial above.

Do not describe `bash run.sh check` as entirely no-network/no-write: only its underlying `check:gameplay` inspection has that property.

## Validation and resume point

New `scripts/test-one-touch.py` executes the actual Bash entrypoints in disposable filesystem fixtures with external command effects stubbed. Its 20 scenarios cover default reset ordering, continue, explicit seed, blocked config, check-only, missing .env, missing check script, bounded eval delegation, EOF/decline/explicit consent, no persistent provider overwrite, failure log/exit code, fetch failure, stash conflicts and the legacy re-exec argument contract. Bash syntax checks are included. The standard Jest suite runs this Python suite through `oneTouchLauncher.test.ts`.

Local Bash fixture checks passed before PR creation. These fixtures are NOT an actual paid-model playtest; the existing CI Minecraft adapter/evaluation smoke tests cover their previously stated non-model scope. Exact-head CI status and merge SHA belong in the PR record, not inferred from the local fixtures.

Next: use the one-touch isolated trial's real log to resolve the first observed T07b blocker. No new memory/gameplay strategy/learning feature is part of this launcher fix.
