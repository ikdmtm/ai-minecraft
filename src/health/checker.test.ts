import { HealthChecker, type HealthCheckTarget, type HealthStatus } from './checker';

function createTarget(overrides: Partial<HealthCheckTarget> = {}): HealthCheckTarget {
  return {
    name: 'test-service',
    check: jest.fn().mockResolvedValue(true),
    failureThreshold: 3,
    ...overrides,
  };
}

describe('HealthChecker', () => {
  it('reports all healthy initially after first check', async () => {
    const checker = new HealthChecker([createTarget({ name: 'svc-a' })]);
    await checker.runChecks();
    const statuses = checker.getStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].healthy).toBe(true);
    expect(statuses[0].consecutiveFailures).toBe(0);
  });

  it('tracks consecutive failures', async () => {
    const target = createTarget({
      name: 'flaky',
      check: jest.fn().mockResolvedValue(false),
      failureThreshold: 3,
    });
    const checker = new HealthChecker([target]);

    await checker.runChecks();
    expect(checker.getStatus('flaky')?.consecutiveFailures).toBe(1);
    expect(checker.getStatus('flaky')?.healthy).toBe(true); // まだ閾値未満

    await checker.runChecks();
    expect(checker.getStatus('flaky')?.consecutiveFailures).toBe(2);
    expect(checker.getStatus('flaky')?.healthy).toBe(true);

    await checker.runChecks();
    expect(checker.getStatus('flaky')?.consecutiveFailures).toBe(3);
    expect(checker.getStatus('flaky')?.healthy).toBe(false); // 閾値到達
  });

  it('resets failures on success', async () => {
    let callCount = 0;
    const target = createTarget({
      name: 'recoverable',
      check: jest.fn().mockImplementation(async () => {
        callCount++;
        return callCount > 2;
      }),
      failureThreshold: 3,
    });
    const checker = new HealthChecker([target]);

    await checker.runChecks(); // fail 1
    await checker.runChecks(); // fail 2
    expect(checker.getStatus('recoverable')?.consecutiveFailures).toBe(2);

    await checker.runChecks(); // success
    expect(checker.getStatus('recoverable')?.consecutiveFailures).toBe(0);
    expect(checker.getStatus('recoverable')?.healthy).toBe(true);
  });

  it('handles check function throwing as failure', async () => {
    const target = createTarget({
      name: 'throwing',
      check: jest.fn().mockRejectedValue(new Error('connection refused')),
      failureThreshold: 1,
    });
    const checker = new HealthChecker([target]);
    await checker.runChecks();

    expect(checker.getStatus('throwing')?.healthy).toBe(false);
    expect(checker.getStatus('throwing')?.consecutiveFailures).toBe(1);
    expect(checker.getStatus('throwing')?.lastError).toContain('connection refused');
  });

  it('tracks multiple targets independently', async () => {
    const healthy = createTarget({ name: 'good', check: jest.fn().mockResolvedValue(true) });
    const unhealthy = createTarget({
      name: 'bad',
      check: jest.fn().mockResolvedValue(false),
      failureThreshold: 1,
    });
    const checker = new HealthChecker([healthy, unhealthy]);
    await checker.runChecks();

    expect(checker.getStatus('good')?.healthy).toBe(true);
    expect(checker.getStatus('bad')?.healthy).toBe(false);
  });

  it('calls onUnhealthy callback when threshold reached', async () => {
    const onUnhealthy = jest.fn();
    const target = createTarget({
      name: 'svc',
      check: jest.fn().mockResolvedValue(false),
      failureThreshold: 2,
    });
    const checker = new HealthChecker([target], { onUnhealthy });

    await checker.runChecks(); // 1回目 - まだ閾値未満
    expect(onUnhealthy).not.toHaveBeenCalled();

    await checker.runChecks(); // 2回目 - 閾値到達
    expect(onUnhealthy).toHaveBeenCalledWith('svc', expect.any(Object));
  });

  it('does not call onUnhealthy again while still unhealthy', async () => {
    const onUnhealthy = jest.fn();
    const target = createTarget({
      name: 'svc',
      check: jest.fn().mockResolvedValue(false),
      failureThreshold: 1,
    });
    const checker = new HealthChecker([target], { onUnhealthy });

    await checker.runChecks();
    await checker.runChecks();
    await checker.runChecks();
    // 閾値到達時の1回だけコールバック
    expect(onUnhealthy).toHaveBeenCalledTimes(1);
  });

  it('calls onRecovered when target recovers', async () => {
    const onRecovered = jest.fn();
    let fail = true;
    const target = createTarget({
      name: 'svc',
      check: jest.fn().mockImplementation(async () => !fail),
      failureThreshold: 1,
    });
    const checker = new HealthChecker([target], { onRecovered });

    await checker.runChecks(); // fail → unhealthy
    fail = false;
    await checker.runChecks(); // success → recovered
    expect(onRecovered).toHaveBeenCalledWith('svc');
  });

  it('isAllHealthy returns correct aggregate', async () => {
    const targets = [
      createTarget({ name: 'a', check: jest.fn().mockResolvedValue(true) }),
      createTarget({ name: 'b', check: jest.fn().mockResolvedValue(true) }),
    ];
    const checker = new HealthChecker(targets);
    await checker.runChecks();
    expect(checker.isAllHealthy()).toBe(true);
  });

  it('isAllHealthy returns false when any target is unhealthy', async () => {
    const targets = [
      createTarget({ name: 'a', check: jest.fn().mockResolvedValue(true) }),
      createTarget({
        name: 'b',
        check: jest.fn().mockResolvedValue(false),
        failureThreshold: 1,
      }),
    ];
    const checker = new HealthChecker(targets);
    await checker.runChecks();
    expect(checker.isAllHealthy()).toBe(false);
  });

  it('getStatus returns undefined for unknown target', () => {
    const checker = new HealthChecker([]);
    expect(checker.getStatus('unknown')).toBeUndefined();
  });
});
