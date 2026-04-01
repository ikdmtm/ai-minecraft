import { StateMachine } from './stateMachine';
import type { OrchestratorState } from '../types/state';
import type { OrchestratorEvent } from '../types/events';

describe('StateMachine', () => {
  let sm: StateMachine;

  beforeEach(() => {
    sm = new StateMachine('IDLE', 'MANUAL');
  });

  it('starts in given initial state', () => {
    expect(sm.getState()).toBe('IDLE');
  });

  // ── MANUAL モード: 基本フロー ──

  describe('MANUAL mode: normal flow', () => {
    it('IDLE → BOOTING on START_TRIGGERED', () => {
      const next = sm.transition({ type: 'START_TRIGGERED' });
      expect(next).toBe('BOOTING');
      expect(sm.getState()).toBe('BOOTING');
    });

    it('BOOTING → PREPARING_STREAM on BOOT_COMPLETE', () => {
      sm.transition({ type: 'START_TRIGGERED' });
      const next = sm.transition({ type: 'BOOT_COMPLETE' });
      expect(next).toBe('PREPARING_STREAM');
    });

    it('PREPARING_STREAM → LIVE_RUNNING on STREAM_READY', () => {
      sm.transition({ type: 'START_TRIGGERED' });
      sm.transition({ type: 'BOOT_COMPLETE' });
      const next = sm.transition({ type: 'STREAM_READY' });
      expect(next).toBe('LIVE_RUNNING');
    });

    it('LIVE_RUNNING → DEATH_DETECTED on death', () => {
      goToLive(sm);
      const next = sm.transition({ type: 'DEATH_DETECTED', cause: 'クリーパー爆発' });
      expect(next).toBe('DEATH_DETECTED');
    });

    it('DEATH_DETECTED → ENDING_STREAM on STREAM_ENDED', () => {
      goToLive(sm);
      sm.transition({ type: 'DEATH_DETECTED', cause: 'ゾンビ' });
      const next = sm.transition({ type: 'STREAM_ENDED' });
      expect(next).toBe('ENDING_STREAM');
    });

    it('ENDING_STREAM → IDLE on MANUAL mode (no auto restart)', () => {
      goToLive(sm);
      sm.transition({ type: 'DEATH_DETECTED', cause: 'ゾンビ' });
      sm.transition({ type: 'STREAM_ENDED' });
      const next = sm.transition({ type: 'COOLDOWN_EXPIRED' });
      expect(next).toBe('IDLE');
    });
  });

  // ── AUTO モード ──

  describe('AUTO mode: auto restart after death', () => {
    beforeEach(() => {
      sm = new StateMachine('IDLE', 'AUTO');
    });

    it('ENDING_STREAM → COOL_DOWN on AUTO mode', () => {
      goToLive(sm);
      sm.transition({ type: 'DEATH_DETECTED', cause: 'ゾンビ' });
      sm.transition({ type: 'STREAM_ENDED' });
      const next = sm.transition({ type: 'COOLDOWN_EXPIRED' });
      expect(next).toBe('COOL_DOWN');
    });

    it('COOL_DOWN → CREATING_NEXT_STREAM', () => {
      goToLive(sm);
      sm.transition({ type: 'DEATH_DETECTED', cause: 'ゾンビ' });
      sm.transition({ type: 'STREAM_ENDED' });
      sm.transition({ type: 'COOLDOWN_EXPIRED' });
      const next = sm.transition({ type: 'NEXT_STREAM_CREATED' });
      expect(next).toBe('CREATING_NEXT_STREAM');
    });

    it('CREATING_NEXT_STREAM → BOOTING on START_TRIGGERED', () => {
      goToLive(sm);
      sm.transition({ type: 'DEATH_DETECTED', cause: 'ゾンビ' });
      sm.transition({ type: 'STREAM_ENDED' });
      sm.transition({ type: 'COOLDOWN_EXPIRED' });
      sm.transition({ type: 'NEXT_STREAM_CREATED' });
      const next = sm.transition({ type: 'START_TRIGGERED' });
      expect(next).toBe('BOOTING');
    });

    it('COOL_DOWN → SUSPENDED_UNTIL_NEXT_DAY on DAILY_LIMIT_REACHED', () => {
      goToLive(sm);
      sm.transition({ type: 'DEATH_DETECTED', cause: 'ゾンビ' });
      sm.transition({ type: 'STREAM_ENDED' });
      sm.transition({ type: 'COOLDOWN_EXPIRED' });
      const next = sm.transition({ type: 'DAILY_LIMIT_REACHED' });
      expect(next).toBe('SUSPENDED_UNTIL_NEXT_DAY');
    });
  });

  // ── リカバリフロー ──

  describe('recovery flow', () => {
    it('any running state → RECOVERING on RECOVERY_FAILED is no-op for non-recovering', () => {
      goToLive(sm);
      // LIVE_RUNNING で RECOVERY_FAILED は無効イベント
      const next = sm.transition({ type: 'RECOVERY_FAILED' });
      expect(next).toBeNull();
      expect(sm.getState()).toBe('LIVE_RUNNING');
    });
  });

  // ── STOP ──

  describe('stop triggered', () => {
    it('LIVE_RUNNING → ENDING_STREAM on STOP_TRIGGERED', () => {
      goToLive(sm);
      const next = sm.transition({ type: 'STOP_TRIGGERED' });
      expect(next).toBe('ENDING_STREAM');
    });

    it('BOOTING → IDLE on STOP_TRIGGERED', () => {
      sm.transition({ type: 'START_TRIGGERED' });
      const next = sm.transition({ type: 'STOP_TRIGGERED' });
      expect(next).toBe('IDLE');
    });

    it('IDLE → null on STOP_TRIGGERED (no-op)', () => {
      const next = sm.transition({ type: 'STOP_TRIGGERED' });
      expect(next).toBeNull();
    });
  });

  // ── 無効なイベント ──

  describe('invalid transitions', () => {
    it('returns null for invalid event in current state', () => {
      const next = sm.transition({ type: 'BOOT_COMPLETE' }); // IDLE で BOOT_COMPLETE は無効
      expect(next).toBeNull();
      expect(sm.getState()).toBe('IDLE');
    });

    it('returns null for STREAM_READY in IDLE', () => {
      const next = sm.transition({ type: 'STREAM_READY' });
      expect(next).toBeNull();
    });
  });

  // ── コールバック ──

  describe('transition callbacks', () => {
    it('calls onTransition callback', () => {
      const cb = jest.fn();
      sm.onTransition(cb);
      sm.transition({ type: 'START_TRIGGERED' });
      expect(cb).toHaveBeenCalledWith('IDLE', 'BOOTING', { type: 'START_TRIGGERED' });
    });

    it('calls callback on every valid transition', () => {
      const cb = jest.fn();
      sm.onTransition(cb);
      sm.transition({ type: 'START_TRIGGERED' });
      sm.transition({ type: 'BOOT_COMPLETE' });
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it('does not call callback on invalid transition', () => {
      const cb = jest.fn();
      sm.onTransition(cb);
      sm.transition({ type: 'BOOT_COMPLETE' }); // invalid in IDLE
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // ── モード切り替え ──

  describe('mode switching', () => {
    it('can switch from MANUAL to AUTO', () => {
      sm.setMode('AUTO');
      expect(sm.getMode()).toBe('AUTO');
    });

    it('mode affects post-death flow', () => {
      goToLive(sm);
      sm.transition({ type: 'DEATH_DETECTED', cause: '溶岩' });
      sm.transition({ type: 'STREAM_ENDED' });

      // MANUAL → IDLE
      let next = sm.transition({ type: 'COOLDOWN_EXPIRED' });
      expect(next).toBe('IDLE');

      // Switch to AUTO and redo
      sm = new StateMachine('IDLE', 'AUTO');
      goToLive(sm);
      sm.transition({ type: 'DEATH_DETECTED', cause: '溶岩' });
      sm.transition({ type: 'STREAM_ENDED' });
      next = sm.transition({ type: 'COOLDOWN_EXPIRED' });
      expect(next).toBe('COOL_DOWN');
    });
  });
});

function goToLive(sm: StateMachine): void {
  sm.transition({ type: 'START_TRIGGERED' });
  sm.transition({ type: 'BOOT_COMPLETE' });
  sm.transition({ type: 'STREAM_READY' });
}
