import { LLMClient, callWithTimeout, type LLMApiAdapter } from './client';
import type { GameState } from '../types/gameState';

const VALID_LLM_JSON = JSON.stringify({
  action: { goal: '木を伐採する', reason: '建材が必要', steps: ['木を伐採する'] },
  commentary: '木材が足りないな。',
  current_goal_update: null,
  threat_level: 'low',
});

const INVALID_LLM_JSON = 'これはJSONではありません';

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

describe('LLMClient', () => {
  describe('successful call', () => {
    it('calls adapter and parses valid response', async () => {
      const adapter: LLMApiAdapter = { call: jest.fn().mockResolvedValue(VALID_LLM_JSON) };
      const client = new LLMClient(adapter, { maxRetries: 0 });
      const result = await client.call(sampleGameState());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.action.goal).toBe('木を伐採する');
      }
      expect(adapter.call).toHaveBeenCalledTimes(1);
    });

    it('resets consecutive failures on success', async () => {
      const adapter: LLMApiAdapter = {
        call: jest.fn()
          .mockRejectedValueOnce(new Error('fail'))
          .mockResolvedValueOnce(VALID_LLM_JSON),
      };
      const client = new LLMClient(adapter, { maxRetries: 1, retryDelayMs: 0 });
      const result = await client.call(sampleGameState());
      expect(result.ok).toBe(true);
      expect(client.getConsecutiveFailures()).toBe(0);
    });
  });

  describe('retry on parse failure', () => {
    it('retries immediately when response is invalid JSON', async () => {
      const adapter: LLMApiAdapter = {
        call: jest.fn()
          .mockResolvedValueOnce(INVALID_LLM_JSON)
          .mockResolvedValueOnce(VALID_LLM_JSON),
      };
      const client = new LLMClient(adapter, { maxRetries: 2, retryDelayMs: 0 });
      const result = await client.call(sampleGameState());
      expect(result.ok).toBe(true);
      expect(adapter.call).toHaveBeenCalledTimes(2);
    });

    it('retries when LLM returns truncated JSON', async () => {
      const truncated = '{"action":{"goal":"帰る","reason":"夜","steps":["帰';
      const adapter: LLMApiAdapter = {
        call: jest.fn()
          .mockResolvedValueOnce(truncated)
          .mockResolvedValueOnce(VALID_LLM_JSON),
      };
      const client = new LLMClient(adapter, { maxRetries: 1, retryDelayMs: 0 });
      const result = await client.call(sampleGameState());
      expect(result.ok).toBe(true);
    });

    it('fails after max retries on persistent parse failure', async () => {
      const adapter: LLMApiAdapter = {
        call: jest.fn().mockResolvedValue(INVALID_LLM_JSON),
      };
      const client = new LLMClient(adapter, { maxRetries: 2, retryDelayMs: 0 });
      const result = await client.call(sampleGameState());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('3回試行後');
      expect(adapter.call).toHaveBeenCalledTimes(3);
    });
  });

  describe('retry on API error', () => {
    it('retries with backoff on API failure', async () => {
      const adapter: LLMApiAdapter = {
        call: jest.fn()
          .mockRejectedValueOnce(new Error('rate limit'))
          .mockResolvedValueOnce(VALID_LLM_JSON),
      };
      const client = new LLMClient(adapter, { maxRetries: 2, retryDelayMs: 10 });
      const result = await client.call(sampleGameState());
      expect(result.ok).toBe(true);
      expect(adapter.call).toHaveBeenCalledTimes(2);
    });

    it('fails after max retries on persistent API error', async () => {
      const adapter: LLMApiAdapter = {
        call: jest.fn().mockRejectedValue(new Error('server down')),
      };
      const client = new LLMClient(adapter, { maxRetries: 2, retryDelayMs: 10 });
      const result = await client.call(sampleGameState());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('server down');
      expect(adapter.call).toHaveBeenCalledTimes(3);
    });

    it('increments consecutiveFailures on final failure', async () => {
      const adapter: LLMApiAdapter = {
        call: jest.fn().mockRejectedValue(new Error('fail')),
      };
      const client = new LLMClient(adapter, { maxRetries: 0, retryDelayMs: 0 });
      await client.call(sampleGameState());
      expect(client.getConsecutiveFailures()).toBe(1);
      await client.call(sampleGameState());
      expect(client.getConsecutiveFailures()).toBe(2);
    });
  });

  describe('mixed failure scenarios', () => {
    it('handles API error then parse error then success', async () => {
      const adapter: LLMApiAdapter = {
        call: jest.fn()
          .mockRejectedValueOnce(new Error('network'))
          .mockResolvedValueOnce(INVALID_LLM_JSON)
          .mockResolvedValueOnce(VALID_LLM_JSON),
      };
      const client = new LLMClient(adapter, { maxRetries: 2, retryDelayMs: 10 });
      const result = await client.call(sampleGameState());
      expect(result.ok).toBe(true);
      expect(adapter.call).toHaveBeenCalledTimes(3);
    });
  });

  describe('generateDeathLesson', () => {
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

    it('handles empty response', async () => {
      const adapter: LLMApiAdapter = { call: jest.fn().mockResolvedValue('  ') };
      const client = new LLMClient(adapter);
      const result = await client.generateDeathLesson({
        position: { x: 0, y: 0, z: 0 }, cause: 'test',
        recentActions: [], survivalMinutes: 0,
      });
      expect(result.ok).toBe(false);
    });

    it('handles API failure', async () => {
      const adapter: LLMApiAdapter = { call: jest.fn().mockRejectedValue(new Error('down')) };
      const client = new LLMClient(adapter);
      const result = await client.generateDeathLesson({
        position: { x: 0, y: 0, z: 0 }, cause: 'test',
        recentActions: [], survivalMinutes: 0,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('down');
    });
  });
});

describe('callWithTimeout', () => {
  it('resolves when function completes within timeout', async () => {
    const result = await callWithTimeout(
      () => Promise.resolve('ok'),
      1000,
    );
    expect(result).toBe('ok');
  });

  it('rejects when function exceeds timeout', async () => {
    await expect(
      callWithTimeout(
        () => new Promise((resolve) => setTimeout(resolve, 500)),
        50,
      ),
    ).rejects.toThrow('タイムアウト');
  });

  it('rejects with original error if function fails before timeout', async () => {
    await expect(
      callWithTimeout(
        () => Promise.reject(new Error('original error')),
        1000,
      ),
    ).rejects.toThrow('original error');
  });
});
