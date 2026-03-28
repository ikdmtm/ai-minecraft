import { DeathHandler, type DeathHandlerDeps } from './deathHandler';

function createMockDeps(overrides: Partial<DeathHandlerDeps> = {}): jest.Mocked<DeathHandlerDeps> {
  return {
    generateLesson: jest.fn().mockResolvedValue({ ok: true, value: '夜は拠点に戻るべき' }),
    addDeathRecord: jest.fn(),
    getState: jest.fn().mockReturnValue({
      currentGeneration: 5,
      bestRecordMinutes: 240,
      survivalStartTime: new Date(Date.now() - 90 * 60_000).toISOString(),
    }),
    saveState: jest.fn(),
    getBestRecord: jest.fn().mockReturnValue(240),
    logAction: jest.fn(),
    ...overrides,
  } as jest.Mocked<DeathHandlerDeps>;
}

describe('DeathHandler', () => {
  it('generates lesson, saves death record, and increments generation', async () => {
    const deps = createMockDeps();
    const handler = new DeathHandler(deps);

    const result = await handler.handleDeath('クリーパー爆発', {
      position: { x: 100, y: 64, z: -50 },
      recentActions: [{ time: 'now', event: 'walking', detail: '夜の森を移動中' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.generation).toBe(5);
    expect(result.value.lesson).toBe('夜は拠点に戻るべき');
    expect(result.value.survivalMinutes).toBeGreaterThan(0);
  });

  it('saves death record to DB', async () => {
    const deps = createMockDeps();
    const handler = new DeathHandler(deps);
    await handler.handleDeath('溶岩', {
      position: { x: 0, y: 30, z: 0 },
      recentActions: [],
    });

    expect(deps.addDeathRecord).toHaveBeenCalledWith(expect.objectContaining({
      generation: 5,
      cause: '溶岩',
      lesson: '夜は拠点に戻るべき',
    }));
  });

  it('increments generation number', async () => {
    const deps = createMockDeps();
    const handler = new DeathHandler(deps);
    await handler.handleDeath('ゾンビ', {
      position: { x: 0, y: 64, z: 0 },
      recentActions: [],
    });

    expect(deps.saveState).toHaveBeenCalledWith(expect.objectContaining({
      currentGeneration: 6,
    }));
  });

  it('updates best record when current run is longer', async () => {
    const deps = createMockDeps({
      getBestRecord: jest.fn().mockReturnValue(30),
    } as any);
    const handler = new DeathHandler(deps);
    const result = await handler.handleDeath('ゾンビ', {
      position: { x: 0, y: 64, z: 0 },
      recentActions: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.isNewRecord).toBe(true);
    expect(deps.saveState).toHaveBeenCalledWith(expect.objectContaining({
      bestRecordMinutes: expect.any(Number),
    }));
  });

  it('does not update best record when current run is shorter', async () => {
    const deps = createMockDeps({
      getBestRecord: jest.fn().mockReturnValue(9999),
    } as any);
    const handler = new DeathHandler(deps);
    const result = await handler.handleDeath('ゾンビ', {
      position: { x: 0, y: 64, z: 0 },
      recentActions: [],
    });

    if (result.ok) expect(result.value.isNewRecord).toBe(false);
  });

  it('handles lesson generation failure gracefully', async () => {
    const deps = createMockDeps({
      generateLesson: jest.fn().mockResolvedValue({ ok: false, error: 'LLM down' }),
    } as any);
    const handler = new DeathHandler(deps);
    const result = await handler.handleDeath('ゾンビ', {
      position: { x: 0, y: 64, z: 0 },
      recentActions: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.lesson).toBe('（教訓生成失敗）');
    expect(deps.addDeathRecord).toHaveBeenCalled();
  });

  it('resets survival start time', async () => {
    const deps = createMockDeps();
    const handler = new DeathHandler(deps);
    await handler.handleDeath('ゾンビ', {
      position: { x: 0, y: 64, z: 0 },
      recentActions: [],
    });

    expect(deps.saveState).toHaveBeenCalledWith(expect.objectContaining({
      survivalStartTime: null,
      currentState: 'DEATH_DETECTED',
    }));
  });

  it('logs the death event', async () => {
    const deps = createMockDeps();
    const handler = new DeathHandler(deps);
    await handler.handleDeath('スケルトン', {
      position: { x: 0, y: 64, z: 0 },
      recentActions: [],
    });

    expect(deps.logAction).toHaveBeenCalledWith(expect.objectContaining({
      type: 'state_change',
      content: expect.stringContaining('スケルトン'),
    }));
  });
});
