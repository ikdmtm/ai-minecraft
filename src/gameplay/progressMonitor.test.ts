import { GameplayProgressMonitor, type GameplayProgressSnapshot } from './progressMonitor.js';

function snap(overrides: Partial<GameplayProgressSnapshot> = {}): GameplayProgressSnapshot {
  return {
    timestamp: 0,
    goal: '木を集める',
    reflexState: 'mining',
    position: { x: 0, y: 64, z: 0 },
    inventory: {},
    ...overrides,
  };
}

describe('GameplayProgressMonitor', () => {
  test('alerts after sustained no-progress', () => {
    const monitor = new GameplayProgressMonitor({
      stallThresholdMs: 10_000,
      alertCooldownMs: 5_000,
      movementThresholdBlocks: 1,
    });

    expect(monitor.observe(snap({ timestamp: 1_000 }))).toBeNull();
    expect(monitor.observe(snap({ timestamp: 5_000 }))).toBeNull();

    const alert = monitor.observe(snap({ timestamp: 11_000 }));
    expect(alert).not.toBeNull();
    expect(alert?.stagnantForMs).toBe(10_000);
    expect(alert?.detail).toContain('No observable world progress');
  });

  test('movement resets the stall timer', () => {
    const monitor = new GameplayProgressMonitor({
      stallThresholdMs: 10_000,
      movementThresholdBlocks: 1,
    });

    monitor.observe(snap({ timestamp: 0 }));
    expect(monitor.observe(snap({
      timestamp: 8_000,
      position: { x: 2, y: 64, z: 0 },
    }))).toBeNull();

    expect(monitor.observe(snap({
      timestamp: 15_000,
      position: { x: 2, y: 64, z: 0 },
    }))).toBeNull();
  });

  test('inventory change counts as progress', () => {
    const monitor = new GameplayProgressMonitor({ stallThresholdMs: 10_000 });

    monitor.observe(snap({ timestamp: 0 }));
    expect(monitor.observe(snap({
      timestamp: 9_000,
      inventory: { oak_log: 1 },
    }))).toBeNull();

    expect(monitor.observe(snap({
      timestamp: 15_000,
      inventory: { oak_log: 1 },
    }))).toBeNull();
  });

  test('goal/state changes alone do not hide a stall', () => {
    const monitor = new GameplayProgressMonitor({ stallThresholdMs: 10_000 });

    monitor.observe(snap({ timestamp: 1_000 }));
    expect(monitor.observe(snap({ timestamp: 6_000, goal: '石を掘る' }))).toBeNull();

    const alert = monitor.observe(snap({
      timestamp: 11_000,
      goal: '探索する',
      reflexState: 'exploring',
    }));

    expect(alert).not.toBeNull();
    expect(alert?.goal).toBe('探索する');
    expect(alert?.reflexState).toBe('exploring');
  });

  test('does not spam alerts during cooldown', () => {
    const monitor = new GameplayProgressMonitor({
      stallThresholdMs: 10_000,
      alertCooldownMs: 5_000,
    });

    monitor.observe(snap({ timestamp: 1_000 }));
    expect(monitor.observe(snap({ timestamp: 11_000 }))).not.toBeNull();
    expect(monitor.observe(snap({ timestamp: 13_000 }))).toBeNull();
    expect(monitor.observe(snap({ timestamp: 16_000 }))).not.toBeNull();
  });
});
