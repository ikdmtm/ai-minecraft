import { ActionFailureGuard } from './actionFailureGuard';

describe('ActionFailureGuard', () => {
  it('blocks a target after repeated failures within the window', () => {
    const guard = new ActionFailureGuard({
      failureThreshold: 3,
      failureWindowMs: 10_000,
      cooldownMs: 30_000,
    });

    expect(guard.recordFailure('oak_log@1,64,1', 1_000).blocked).toBe(false);
    expect(guard.recordFailure('oak_log@1,64,1', 2_000).blocked).toBe(false);
    const result = guard.recordFailure('oak_log@1,64,1', 3_000);

    expect(result.blocked).toBe(true);
    expect(guard.isBlocked('oak_log@1,64,1', 5_000)).toBe(true);
  });

  it('unblocks after the cooldown expires', () => {
    const guard = new ActionFailureGuard({
      failureThreshold: 2,
      failureWindowMs: 10_000,
      cooldownMs: 5_000,
    });

    guard.recordFailure('oak_log@1,64,1', 1_000);
    guard.recordFailure('oak_log@1,64,1', 2_000);

    expect(guard.isBlocked('oak_log@1,64,1', 6_000)).toBe(true);
    expect(guard.isBlocked('oak_log@1,64,1', 7_001)).toBe(false);
  });

  it('resets the failure streak after a success', () => {
    const guard = new ActionFailureGuard({
      failureThreshold: 2,
      failureWindowMs: 10_000,
      cooldownMs: 5_000,
    });

    guard.recordFailure('oak_log@1,64,1', 1_000);
    guard.recordSuccess('oak_log@1,64,1');
    const result = guard.recordFailure('oak_log@1,64,1', 2_000);

    expect(result.count).toBe(1);
    expect(result.blocked).toBe(false);
  });
});
