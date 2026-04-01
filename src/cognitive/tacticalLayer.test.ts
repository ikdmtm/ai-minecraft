import { TacticalLayer } from './tacticalLayer';
import { SharedStateBus } from './sharedState';
import type { TacticalLayerEvents } from './tacticalLayer';
import type { LLMApiAdapter } from '../llm/client';
import type { BotSensors } from '../bot/types';

function makeMockSensors(overrides: Partial<BotSensors> = {}): BotSensors {
  return {
    hp: 20, maxHp: 20, hunger: 20, oxygen: 300,
    isOnFire: false, nearbyEntities: [], blockBelow: 'grass_block',
    hasFood: true, foodItem: 'bread', inventoryFull: false,
    isNight: false, baseKnown: false, baseDistance: null,
    ...overrides,
  };
}

function makeMockReflexLayer(sensors: BotSensors = makeMockSensors()) {
  return {
    getSensors: jest.fn(() => sensors),
    interruptCurrentAction: jest.fn(),
  } as any;
}

describe('TacticalLayer', () => {
  let shared: SharedStateBus;
  let events: TacticalLayerEvents & { commentaries: string[]; goalChanges: string[] };
  let mockAdapter: jest.Mocked<LLMApiAdapter>;

  beforeEach(() => {
    shared = new SharedStateBus();
    events = {
      commentaries: [],
      goalChanges: [],
      onCommentary: jest.fn((text: string) => events.commentaries.push(text)),
      onGoalAdjusted: jest.fn((goal: string) => events.goalChanges.push(goal)),
    };
    mockAdapter = { call: jest.fn() };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('start/stop', () => {
    it('start 後に stop すればタイマーが停止する', () => {
      jest.useFakeTimers();
      const reflex = makeMockReflexLayer();
      const layer = new TacticalLayer(mockAdapter, shared, reflex, events);

      layer.start();
      layer.stop();

      jest.advanceTimersByTime(10_000);
      expect(mockAdapter.call).not.toHaveBeenCalled();
    });

    it('二重 start は無視される', () => {
      jest.useFakeTimers();
      const reflex = makeMockReflexLayer();
      const layer = new TacticalLayer(mockAdapter, shared, reflex, events);

      layer.start();
      layer.start();
      layer.stop();
    });
  });

  describe('サイクル実行', () => {
    it('LLM が正常応答を返すとコメンタリーが配信される', async () => {
      const reflex = makeMockReflexLayer();
      mockAdapter.call.mockResolvedValue(JSON.stringify({
        goal_adjustment: null,
        commentary: 'よし、木を集めよう。',
        threat_assessment: 'safe',
        emotion_shift: null,
      }));

      const layer = new TacticalLayer(mockAdapter, shared, reflex, events);
      // 直接 runCycle を呼ぶためにアクセス
      layer.start();

      // 最初のタイマー発火を待つ
      await new Promise(r => setTimeout(r, 100));
      // runCycle が非同期で実行されるので少し待つ
      await waitFor(() => mockAdapter.call.mock.calls.length >= 1, 10_000);

      layer.stop();

      expect(events.onCommentary).toHaveBeenCalledWith('よし、木を集めよう。');
      expect(shared.get().currentCommentary).toBe('よし、木を集めよう。');
    }, 15_000);

    it('goal_adjustment があると共有ステートの目標が変更される', async () => {
      const reflex = makeMockReflexLayer();
      mockAdapter.call.mockResolvedValue(JSON.stringify({
        goal_adjustment: '洞窟を探索する',
        commentary: '洞窟が見える、入ってみよう。',
        threat_assessment: 'caution',
        emotion_shift: { valence: 0.1 },
      }));

      const layer = new TacticalLayer(mockAdapter, shared, reflex, events);
      layer.start();

      await waitFor(() => mockAdapter.call.mock.calls.length >= 1, 10_000);
      layer.stop();

      expect(shared.get().currentGoal).toBe('洞窟を探索する');
      expect(reflex.interruptCurrentAction).toHaveBeenCalled();
      expect(events.onGoalAdjusted).toHaveBeenCalledWith('洞窟を探索する');
    }, 15_000);

    it('LLM エラーでもクラッシュしない', async () => {
      const reflex = makeMockReflexLayer();
      mockAdapter.call.mockRejectedValue(new Error('API error'));

      const layer = new TacticalLayer(mockAdapter, shared, reflex, events);
      layer.start();

      await waitFor(() => mockAdapter.call.mock.calls.length >= 1, 10_000);
      layer.stop();

      expect(events.onCommentary).not.toHaveBeenCalled();
    }, 15_000);

    it('不正な JSON でもクラッシュしない', async () => {
      const reflex = makeMockReflexLayer();
      mockAdapter.call.mockResolvedValue('not json at all');

      const layer = new TacticalLayer(mockAdapter, shared, reflex, events);
      layer.start();

      await waitFor(() => mockAdapter.call.mock.calls.length >= 1, 10_000);
      layer.stop();

      expect(events.onCommentary).not.toHaveBeenCalled();
    }, 15_000);

    it('emotion_shift が適用される', async () => {
      const reflex = makeMockReflexLayer();
      mockAdapter.call.mockResolvedValue(JSON.stringify({
        goal_adjustment: null,
        commentary: '怖い…',
        threat_assessment: 'danger',
        emotion_shift: { valence: -0.3, arousal: 0.4 },
      }));

      const before = { ...shared.get().emotionalState };
      const layer = new TacticalLayer(mockAdapter, shared, reflex, events);
      layer.start();

      await waitFor(() => mockAdapter.call.mock.calls.length >= 1, 10_000);
      layer.stop();

      const after = shared.get().emotionalState;
      expect(after.valence).toBeLessThan(before.valence);
      expect(after.arousal).toBeGreaterThan(before.arousal);
    }, 15_000);

    it('コードブロックで囲まれた JSON もパースできる', async () => {
      const reflex = makeMockReflexLayer();
      mockAdapter.call.mockResolvedValue('```json\n{"goal_adjustment":null,"commentary":"テスト","threat_assessment":"safe","emotion_shift":null}\n```');

      const layer = new TacticalLayer(mockAdapter, shared, reflex, events);
      layer.start();

      await waitFor(() => mockAdapter.call.mock.calls.length >= 1, 10_000);
      layer.stop();

      expect(events.onCommentary).toHaveBeenCalledWith('テスト');
    }, 15_000);
  });

  describe('プロンプト構築', () => {
    it('センサー情報が LLM に渡される', async () => {
      const sensors = makeMockSensors({ hp: 10, hunger: 5, isNight: true });
      const reflex = makeMockReflexLayer(sensors);
      shared.setGoal('鉄鉱石を採掘');
      mockAdapter.call.mockResolvedValue('{}');

      const layer = new TacticalLayer(mockAdapter, shared, reflex, events);
      layer.start();

      await waitFor(() => mockAdapter.call.mock.calls.length >= 1, 10_000);
      layer.stop();

      const userMsg = mockAdapter.call.mock.calls[0][1];
      const parsed = JSON.parse(userMsg);
      expect(parsed.hp).toBe(10);
      expect(parsed.hunger).toBe(5);
      expect(parsed.is_night).toBe(true);
      expect(parsed.current_goal).toBe('鉄鉱石を採掘');
    }, 15_000);
  });
});

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(check, 50);
    };
    check();
  });
}
