import type { Position } from '../types/index.js';
import {
  describeDisconnectReason,
  formatRuntimeDiagnostics,
  type ReflexRuntimeDiagnostics,
} from './reflexLayer';

function createDiagnostics(overrides: Partial<ReflexRuntimeDiagnostics> = {}): ReflexRuntimeDiagnostics {
  return {
    reflexState: 'mining',
    currentGoal: '木を伐採して作業台を作る',
    threatLevel: 'danger',
    currentActionLabel: 'mine_logs',
    currentActionAgeMs: 1800,
    lastTickAgeMs: 260,
    maxTickDriftMs: 120,
    lastPacketAgeMs: 140,
    lastKeepAliveAgeMs: 150,
    lastPhysicsTickAgeMs: 70,
    lastMoveAgeMs: 90,
    hp: 7,
    hunger: 11,
    position: { x: 12.4, y: 64, z: -3.6 },
    ...overrides,
  };
}

describe('formatRuntimeDiagnostics', () => {
  it('formats the current reflex state and runtime telemetry into one compact line', () => {
    const formatted = formatRuntimeDiagnostics(createDiagnostics());

    expect(formatted).toContain('state=mining');
    expect(formatted).toContain('goal=木を伐採して作業台を作る');
    expect(formatted).toContain('action=mine_logs');
    expect(formatted).toContain('actionAge=1800ms');
    expect(formatted).toContain('tickAge=260ms');
    expect(formatted).toContain('maxTickDrift=120ms');
    expect(formatted).toContain('packetAge=140ms');
    expect(formatted).toContain('keepAliveAge=150ms');
    expect(formatted).toContain('physicsAge=70ms');
    expect(formatted).toContain('moveAge=90ms');
    expect(formatted).toContain('hp=7');
    expect(formatted).toContain('hunger=11');
    expect(formatted).toContain('pos=12,64,-4');
  });

  it('falls back to n/a when runtime telemetry has not been observed yet', () => {
    const formatted = formatRuntimeDiagnostics(createDiagnostics({
      currentActionLabel: null,
      currentActionAgeMs: null,
      lastTickAgeMs: null,
      lastPacketAgeMs: null,
      lastKeepAliveAgeMs: null,
      lastPhysicsTickAgeMs: null,
      lastMoveAgeMs: null,
      hp: null,
      hunger: null,
      position: null,
    }));

    expect(formatted).toContain('action=none');
    expect(formatted).toContain('actionAge=n/a');
    expect(formatted).toContain('tickAge=n/a');
    expect(formatted).toContain('packetAge=n/a');
    expect(formatted).toContain('keepAliveAge=n/a');
    expect(formatted).toContain('physicsAge=n/a');
    expect(formatted).toContain('moveAge=n/a');
    expect(formatted).toContain('hp=n/a');
    expect(formatted).toContain('hunger=n/a');
    expect(formatted).toContain('pos=n/a');
  });
});

describe('describeDisconnectReason', () => {
  it('appends runtime diagnostics to the disconnect reason', () => {
    const message = describeDisconnectReason(
      new Error('client timed out after 30000 milliseconds'),
      createDiagnostics(),
    );

    expect(message).toContain('client timed out after 30000 milliseconds');
    expect(message).toContain('state=mining');
    expect(message).toContain('action=mine_logs');
    expect(message).toContain('keepAliveAge=150ms');
  });
});
