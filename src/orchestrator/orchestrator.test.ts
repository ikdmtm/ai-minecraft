import { Orchestrator, type OrchestratorDeps } from './orchestrator';

function createMockDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    bootServices: jest.fn().mockResolvedValue({ ok: true }),
    prepareStream: jest.fn().mockResolvedValue({
      ok: true,
      value: { broadcastId: 'bc-1', streamId: 'st-1', streamKey: 'key-1', rtmpUrl: 'rtmp://test' },
    }),
    runOneCycle: jest.fn().mockResolvedValue({ ok: true, value: {} }),
    handleDeath: jest.fn().mockResolvedValue({
      ok: true,
      value: { generation: 1, survivalMinutes: 30, cause: 'ゾンビ', lesson: '教訓', isNewRecord: false },
    }),
    endStream: jest.fn().mockResolvedValue({ ok: true }),
    isPlayerDead: jest.fn().mockReturnValue(false),
    saveState: jest.fn(),
    getConfig: jest.fn().mockReturnValue({ cooldownMinutes: 0, maxDailyStreams: 20 }),
    getDailyStreamCount: jest.fn().mockReturnValue(0),
    incrementDailyStreamCount: jest.fn(),
    startCycleTimer: jest.fn(),
    stopCycleTimer: jest.fn(),
    log: jest.fn(),
    ...overrides,
  };
}

describe('Orchestrator', () => {
  describe('MANUAL mode', () => {
    it('starts from IDLE, boots, prepares, goes live', async () => {
      const deps = createMockDeps();
      const orch = new Orchestrator(deps, 'MANUAL');

      expect(orch.getState()).toBe('IDLE');
      await orch.start();

      expect(deps.bootServices).toHaveBeenCalled();
      expect(deps.prepareStream).toHaveBeenCalled();
      expect(orch.getState()).toBe('LIVE_RUNNING');
    });

    it('transitions to IDLE after death in MANUAL mode', async () => {
      const deps = createMockDeps();
      const orch = new Orchestrator(deps, 'MANUAL');

      await orch.start();
      expect(orch.getState()).toBe('LIVE_RUNNING');

      await orch.onDeath('ゾンビ');
      expect(deps.handleDeath).toHaveBeenCalled();
      expect(deps.endStream).toHaveBeenCalled();
      expect(orch.getState()).toBe('IDLE');
    });

    it('does not auto-restart after death', async () => {
      const deps = createMockDeps();
      const orch = new Orchestrator(deps, 'MANUAL');

      await orch.start();
      await orch.onDeath('ゾンビ');

      expect(deps.bootServices).toHaveBeenCalledTimes(1);
      expect(orch.getState()).toBe('IDLE');
    });
  });

  describe('AUTO mode', () => {
    it('auto-restarts after death', async () => {
      const deps = createMockDeps();
      const orch = new Orchestrator(deps, 'AUTO');

      await orch.start();
      await orch.onDeath('ゾンビ');

      // AUTO: 死亡 → endStream → cooldown(0) → boot → prepare → LIVE_RUNNING
      expect(deps.bootServices).toHaveBeenCalledTimes(2);
      expect(deps.prepareStream).toHaveBeenCalledTimes(2);
      expect(orch.getState()).toBe('LIVE_RUNNING');
    });

    it('stops at daily limit', async () => {
      const deps = createMockDeps({
        getDailyStreamCount: jest.fn().mockReturnValue(20),
        getConfig: jest.fn().mockReturnValue({ cooldownMinutes: 0, maxDailyStreams: 20 }),
      });
      const orch = new Orchestrator(deps, 'AUTO');

      await orch.start();
      await orch.onDeath('ゾンビ');

      expect(orch.getState()).toBe('SUSPENDED_UNTIL_NEXT_DAY');
      expect(deps.bootServices).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop', () => {
    it('stops while LIVE_RUNNING', async () => {
      const deps = createMockDeps();
      const orch = new Orchestrator(deps, 'MANUAL');

      await orch.start();
      await orch.stop();

      expect(deps.endStream).toHaveBeenCalled();
      expect(deps.stopCycleTimer).toHaveBeenCalled();
      expect(orch.getState()).toBe('IDLE');
    });

    it('stop is safe when already IDLE', async () => {
      const deps = createMockDeps();
      const orch = new Orchestrator(deps, 'MANUAL');
      await orch.stop();
      expect(orch.getState()).toBe('IDLE');
    });
  });

  describe('boot failure', () => {
    it('returns to IDLE on boot failure', async () => {
      const deps = createMockDeps({
        bootServices: jest.fn().mockResolvedValue({ ok: false, error: 'Minecraft down' }),
      });
      const orch = new Orchestrator(deps, 'MANUAL');
      await orch.start();
      expect(orch.getState()).toBe('IDLE');
      expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Minecraft down'));
    });
  });

  describe('stream preparation failure', () => {
    it('returns to IDLE on stream prep failure', async () => {
      const deps = createMockDeps({
        prepareStream: jest.fn().mockResolvedValue({ ok: false, error: 'YouTube API error' }),
      });
      const orch = new Orchestrator(deps, 'MANUAL');
      await orch.start();
      expect(orch.getState()).toBe('IDLE');
    });
  });

  describe('mode switching', () => {
    it('can switch mode at runtime', () => {
      const deps = createMockDeps();
      const orch = new Orchestrator(deps, 'MANUAL');
      expect(orch.getMode()).toBe('MANUAL');
      orch.setMode('AUTO');
      expect(orch.getMode()).toBe('AUTO');
    });
  });
});
