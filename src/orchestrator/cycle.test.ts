import { CycleRunner, type CycleDeps } from './cycle';
import type { GameState } from '../types/gameState';
import type { LLMOutput } from '../types/llm';
import type { Result } from '../types/result';

function sampleGameState(): GameState {
  return {
    player: {
      hp: 20, maxHp: 20, hunger: 20,
      position: { x: 0, y: 64, z: 0 }, biome: 'plains',
      equipment: { hand: null, helmet: null, chestplate: null, leggings: null, boots: null },
      inventorySummary: [],
    },
    world: {
      timeOfDay: 'day', minecraftTime: 6000, weather: 'clear', lightLevel: 15,
      nearbyEntities: [], nearbyBlocksOfInterest: [],
    },
    base: { known: false, position: null, distance: null, hasBed: false, hasFurnace: false, hasCraftingTable: false },
    pacing: { currentActionCategory: 'waiting', categoryDurationMinutes: 0, survivalTimeMinutes: 0, progressPhase: 'early', bestRecordMinutes: 0 },
    previousPlan: null,
    recentEvents: [],
    stagnationWarning: false,
    memory: { totalDeaths: 0, bestRecordMinutes: 0, recentDeaths: [] },
  };
}

function sampleLLMOutput(): LLMOutput {
  return {
    action: { goal: '木を伐採する', reason: '建材が必要', steps: ['木を伐採する'] },
    commentary: '木材を集めよう。',
    currentGoalUpdate: null,
    threatLevel: 'low',
  };
}

function createMockDeps(overrides: Partial<CycleDeps> = {}): CycleDeps {
  return {
    getGameState: jest.fn().mockReturnValue(sampleGameState()),
    callLLM: jest.fn().mockResolvedValue({ ok: true, value: sampleLLMOutput() } as Result<LLMOutput>),
    executeSteps: jest.fn().mockResolvedValue(undefined),
    speakCommentary: jest.fn().mockResolvedValue(undefined),
    updateOverlay: jest.fn(),
    updateAvatar: jest.fn(),
    triggerAvatarSpecial: jest.fn(),
    logAction: jest.fn(),
    ...overrides,
  };
}

describe('CycleRunner', () => {
  it('executes a full cycle: getState → LLM → execute + speak', async () => {
    const deps = createMockDeps();
    const runner = new CycleRunner(deps);

    const result = await runner.runOneCycle();

    expect(result.ok).toBe(true);
    expect(deps.getGameState).toHaveBeenCalledTimes(1);
    expect(deps.callLLM).toHaveBeenCalledTimes(1);
    expect(deps.executeSteps).toHaveBeenCalledWith(['木を伐採する']);
    expect(deps.speakCommentary).toHaveBeenCalledWith('木材を集めよう。');
    expect(deps.updateOverlay).toHaveBeenCalledWith(expect.objectContaining({
      threatLevel: 'low',
      commentary: '木材を集めよう。',
    }));
  });

  it('logs the LLM output', async () => {
    const deps = createMockDeps();
    const runner = new CycleRunner(deps);
    await runner.runOneCycle();

    expect(deps.logAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'llm_response' }),
    );
  });

  it('returns previous plan info for next cycle', async () => {
    const deps = createMockDeps();
    const runner = new CycleRunner(deps);
    await runner.runOneCycle();

    expect(runner.getPreviousPlan()).toEqual({
      goal: '木を伐採する',
      status: 'in_progress',
      progress: '',
    });
  });

  it('handles LLM failure gracefully', async () => {
    const deps = createMockDeps({
      callLLM: jest.fn().mockResolvedValue({ ok: false, error: 'API timeout' }),
    });
    const runner = new CycleRunner(deps);
    const result = await runner.runOneCycle();

    expect(result.ok).toBe(false);
    expect(deps.executeSteps).not.toHaveBeenCalled();
    expect(deps.speakCommentary).not.toHaveBeenCalled();
  });

  it('skips speak when commentary is empty', async () => {
    const emptyCommentary = { ...sampleLLMOutput(), commentary: '' };
    const deps = createMockDeps({
      callLLM: jest.fn().mockResolvedValue({ ok: true, value: emptyCommentary }),
    });
    const runner = new CycleRunner(deps);
    await runner.runOneCycle();

    expect(deps.speakCommentary).not.toHaveBeenCalled();
  });

  it('updates currentGoal when LLM provides it', async () => {
    const withGoal = { ...sampleLLMOutput(), currentGoalUpdate: '鉄装備を完成させる' };
    const deps = createMockDeps({
      callLLM: jest.fn().mockResolvedValue({ ok: true, value: withGoal }),
    });
    const runner = new CycleRunner(deps);
    await runner.runOneCycle();

    expect(deps.updateOverlay).toHaveBeenCalledWith(expect.objectContaining({
      currentGoal: '鉄装備を完成させる',
    }));
  });

  it('updates avatar with threat level and speaking state', async () => {
    const deps = createMockDeps();
    const runner = new CycleRunner(deps);
    await runner.runOneCycle();

    expect(deps.updateAvatar).toHaveBeenCalledWith('low', true);
  });

  it('triggers thinking expression before LLM call', async () => {
    const deps = createMockDeps();
    const runner = new CycleRunner(deps);
    await runner.runOneCycle();

    expect(deps.triggerAvatarSpecial).toHaveBeenCalledWith('thinking');
    const thinkingCallOrder = (deps.triggerAvatarSpecial as jest.Mock).mock.invocationCallOrder[0];
    const llmCallOrder = (deps.callLLM as jest.Mock).mock.invocationCallOrder[0];
    expect(thinkingCallOrder).toBeLessThan(llmCallOrder);
  });

  it('passes isSpeaking=false when commentary is empty', async () => {
    const emptyComm = { ...sampleLLMOutput(), commentary: '' };
    const deps = createMockDeps({
      callLLM: jest.fn().mockResolvedValue({ ok: true, value: emptyComm }),
    });
    const runner = new CycleRunner(deps);
    await runner.runOneCycle();

    expect(deps.updateAvatar).toHaveBeenCalledWith('low', false);
  });

  // ── 新規: speakCommentary 障害耐性 ──

  describe('fault isolation', () => {
    it('executeSteps succeeds even when speakCommentary throws', async () => {
      const deps = createMockDeps({
        speakCommentary: jest.fn().mockRejectedValue(new Error('VOICEVOX down')),
      });
      const runner = new CycleRunner(deps);
      const result = await runner.runOneCycle();

      expect(result.ok).toBe(true);
      expect(deps.executeSteps).toHaveBeenCalled();
    });

    it('logs error when speakCommentary fails', async () => {
      const deps = createMockDeps({
        speakCommentary: jest.fn().mockRejectedValue(new Error('VOICEVOX down')),
      });
      const runner = new CycleRunner(deps);
      await runner.runOneCycle();

      expect(deps.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          content: expect.stringContaining('VOICEVOX down'),
        }),
      );
    });

    it('speakCommentary succeeds even when executeSteps throws', async () => {
      const deps = createMockDeps({
        executeSteps: jest.fn().mockRejectedValue(new Error('Bot disconnected')),
      });
      const runner = new CycleRunner(deps);
      const result = await runner.runOneCycle();

      expect(result.ok).toBe(true);
      expect(deps.speakCommentary).toHaveBeenCalled();
    });

    it('logs error when executeSteps fails', async () => {
      const deps = createMockDeps({
        executeSteps: jest.fn().mockRejectedValue(new Error('Bot disconnected')),
      });
      const runner = new CycleRunner(deps);
      await runner.runOneCycle();

      expect(deps.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          content: expect.stringContaining('Bot disconnected'),
        }),
      );
    });

    it('both failures are logged independently', async () => {
      const deps = createMockDeps({
        executeSteps: jest.fn().mockRejectedValue(new Error('bot error')),
        speakCommentary: jest.fn().mockRejectedValue(new Error('tts error')),
      });
      const runner = new CycleRunner(deps);
      await runner.runOneCycle();

      const errorLogs = (deps.logAction as jest.Mock).mock.calls
        .filter((c: any) => c[0].type === 'error');
      expect(errorLogs).toHaveLength(2);
    });
  });

  // ── 新規: 同時実行ガード ──

  describe('concurrent execution guard', () => {
    it('rejects concurrent cycle runs', async () => {
      let resolveFirst: () => void;
      const blockingPromise = new Promise<void>((r) => { resolveFirst = r; });

      const deps = createMockDeps({
        executeSteps: jest.fn().mockReturnValue(blockingPromise),
      });
      const runner = new CycleRunner(deps);

      const first = runner.runOneCycle();
      const second = runner.runOneCycle();

      const secondResult = await second;
      expect(secondResult.ok).toBe(false);
      if (!secondResult.ok) expect(secondResult.error).toContain('実行中');

      resolveFirst!();
      const firstResult = await first;
      expect(firstResult.ok).toBe(true);
    });

    it('isRunning reflects cycle state', async () => {
      const deps = createMockDeps();
      const runner = new CycleRunner(deps);
      expect(runner.isRunning()).toBe(false);

      const promise = runner.runOneCycle();
      // Note: since deps are all sync-resolved mocks, running flag toggles fast
      await promise;
      expect(runner.isRunning()).toBe(false);
    });

    it('allows next cycle after previous completes', async () => {
      const deps = createMockDeps();
      const runner = new CycleRunner(deps);

      await runner.runOneCycle();
      const result = await runner.runOneCycle();
      expect(result.ok).toBe(true);
      expect(deps.callLLM).toHaveBeenCalledTimes(2);
    });
  });
});
