import { LLMClient, type LLMApiAdapter } from './client';
import type { GameState } from '../types/gameState';

const VALID_LLM_JSON = JSON.stringify({
  action: { goal: '木を伐採する', reason: '建材が必要', steps: ['木を伐採する'] },
  commentary: '木材が足りないな。',
  current_goal_update: null,
  threat_level: 'low',
});

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

function createMockAdapter(response: string, shouldFail = false): LLMApiAdapter {
  return {
    call: jest.fn().mockImplementation(async () => {
      if (shouldFail) throw new Error('API error');
      return response;
    }),
  };
}

describe('LLMClient', () => {
  it('calls adapter and parses valid response', async () => {
    const adapter = createMockAdapter(VALID_LLM_JSON);
    const client = new LLMClient(adapter);
    const result = await client.call(sampleGameState());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action.goal).toBe('木を伐採する');
      expect(result.value.commentary).toBe('木材が足りないな。');
    }
    expect(adapter.call).toHaveBeenCalledTimes(1);
  });

  it('returns error when adapter throws', async () => {
    const adapter = createMockAdapter('', true);
    const client = new LLMClient(adapter);
    const result = await client.call(sampleGameState());
    expect(result.ok).toBe(false);
  });

  it('returns error when response is invalid JSON', async () => {
    const adapter = createMockAdapter('not json at all');
    const client = new LLMClient(adapter);
    const result = await client.call(sampleGameState());
    expect(result.ok).toBe(false);
  });

  it('tracks consecutive failures', async () => {
    const adapter = createMockAdapter('', true);
    const client = new LLMClient(adapter);
    expect(client.getConsecutiveFailures()).toBe(0);

    await client.call(sampleGameState());
    expect(client.getConsecutiveFailures()).toBe(1);

    await client.call(sampleGameState());
    expect(client.getConsecutiveFailures()).toBe(2);
  });

  it('resets failure count on success', async () => {
    const failAdapter = createMockAdapter('', true);
    const client = new LLMClient(failAdapter);
    await client.call(sampleGameState());
    await client.call(sampleGameState());
    expect(client.getConsecutiveFailures()).toBe(2);

    // Swap to successful adapter
    (client as any).adapter = createMockAdapter(VALID_LLM_JSON);
    await client.call(sampleGameState());
    expect(client.getConsecutiveFailures()).toBe(0);
  });

  it('generates death lesson', async () => {
    const adapter: LLMApiAdapter = {
      call: jest.fn().mockResolvedValue('夜間に拠点外を移動しないこと'),
    };
    const client = new LLMClient(adapter);
    const lesson = await client.generateDeathLesson({
      position: { x: 100, y: 64, z: -50 },
      cause: 'クリーパー爆発',
      recentActions: [{ time: 'now', event: 'walking', detail: '夜の森を移動中' }],
      survivalMinutes: 30,
    });
    expect(lesson.ok).toBe(true);
    if (lesson.ok) expect(lesson.value).toContain('夜間');
  });
});
