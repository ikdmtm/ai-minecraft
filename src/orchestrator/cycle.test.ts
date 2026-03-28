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
});
