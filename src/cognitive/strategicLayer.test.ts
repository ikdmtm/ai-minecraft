import { StrategicLayer } from './strategicLayer';
import { SharedStateBus } from './sharedState';
import type { StrategicLayerDeps, StrategicOutput } from './strategicLayer';
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

function makeValidResponse(overrides: Partial<StrategicOutput> = {}): string {
  return JSON.stringify({
    main_goal: '石のツルハシを作成する',
    sub_goals: ['原木を3本集める', '板材にクラフト', '棒を作る', '作業台で石のツルハシ'],
    progress_assessment: '初期段階。道具が必要',
    lessons_learned: ['夜間は外に出ない方が安全'],
    personality_note: '慎重に進めている。少し不安',
    ...overrides,
  });
}

describe('StrategicLayer', () => {
  let shared: SharedStateBus;
  let mockAdapter: jest.Mocked<LLMApiAdapter>;
  let deps: StrategicLayerDeps;
  let goalChanges: string[];
  let subGoalChanges: string[][];

  beforeEach(() => {
    shared = new SharedStateBus();
    mockAdapter = { call: jest.fn() };
    goalChanges = [];
    subGoalChanges = [];
    deps = {
      adapter: mockAdapter,
      shared,
      getSensors: jest.fn(() => makeMockSensors()),
      getInventorySummary: jest.fn(() => ['oak_log x5', 'cobblestone x12']),
      getDeathHistory: jest.fn(() => []),
      getSkillSummaries: jest.fn(() => []),
      onGoalSet: jest.fn((g: string) => goalChanges.push(g)),
      onSubGoalsSet: jest.fn((gs: string[]) => subGoalChanges.push(gs)),
    };
  });

  describe('parseResponse', () => {
    it('正常な JSON をパースできる', () => {
      const layer = new StrategicLayer(deps);
      const result = (layer as any).parseStrategicResponse(makeValidResponse());

      expect(result.mainGoal).toBe('石のツルハシを作成する');
      expect(result.subGoals).toHaveLength(4);
      expect(result.lessonsLearned).toHaveLength(1);
    });

    it('コードブロック内の JSON もパースできる', () => {
      const layer = new StrategicLayer(deps);
      const wrapped = '```json\n' + makeValidResponse() + '\n```';
      const result = (layer as any).parseStrategicResponse(wrapped);

      expect(result.mainGoal).toBe('石のツルハシを作成する');
    });

    it('空文字列はデフォルト値を返す', () => {
      const layer = new StrategicLayer(deps);
      const result = (layer as any).parseStrategicResponse('');

      expect(result.mainGoal).toBe('');
      expect(result.subGoals).toEqual([]);
    });

    it('不正な JSON はデフォルト値を返す', () => {
      const layer = new StrategicLayer(deps);
      const result = (layer as any).parseStrategicResponse('not json');

      expect(result.mainGoal).toBe('');
    });
  });

  describe('applyOutput', () => {
    it('mainGoal を SharedState に設定する', () => {
      const layer = new StrategicLayer(deps);
      (layer as any).applyOutput({
        mainGoal: '鉄鉱石を探す',
        subGoals: ['洞窟を見つける', '鉄を採掘'],
        progressAssessment: '順調',
        lessonsLearned: ['光源を持ち歩く'],
        personalityNote: '',
      });

      expect(shared.get().currentGoal).toBe('鉄鉱石を探す');
      expect(shared.get().subGoals).toEqual(['洞窟を見つける', '鉄を採掘']);
      expect(shared.get().lessonsThisLife).toContain('光源を持ち歩く');
    });

    it('空の mainGoal は既存の目標を維持する', () => {
      shared.setGoal('既存の目標');
      const layer = new StrategicLayer(deps);
      (layer as any).applyOutput({
        mainGoal: '',
        subGoals: [],
        progressAssessment: '',
        lessonsLearned: [],
        personalityNote: '',
      });

      expect(shared.get().currentGoal).toBe('既存の目標');
    });

    it('コールバックが呼ばれる', () => {
      const layer = new StrategicLayer(deps);
      (layer as any).applyOutput({
        mainGoal: 'テスト目標',
        subGoals: ['A', 'B'],
        progressAssessment: '',
        lessonsLearned: [],
        personalityNote: '',
      });

      expect(goalChanges).toEqual(['テスト目標']);
      expect(subGoalChanges).toEqual([['A', 'B']]);
    });
  });

  describe('サイクル実行', () => {
    it('start → runCycle → stop が正常に動作する', async () => {
      mockAdapter.call.mockResolvedValue(makeValidResponse());

      const layer = new StrategicLayer(deps);
      layer.start();

      await waitFor(() => mockAdapter.call.mock.calls.length >= 1, 60_000);
      layer.stop();

      expect(shared.get().currentGoal).toBe('石のツルハシを作成する');
      expect(shared.get().subGoals).toHaveLength(4);
    }, 65_000);

    it('LLM エラーでもクラッシュしない', async () => {
      mockAdapter.call.mockRejectedValue(new Error('timeout'));

      const layer = new StrategicLayer(deps);
      layer.start();

      await waitFor(() => mockAdapter.call.mock.calls.length >= 1, 60_000);
      layer.stop();

      expect(shared.get().currentGoal).toBe('');
    }, 65_000);

    it('死亡履歴がプロンプトに含まれる', async () => {
      (deps.getDeathHistory as jest.Mock).mockReturnValue([
        { generation: 1, survivalMinutes: 5, cause: 'creeper', lesson: 'クリーパーに注意' },
      ]);
      mockAdapter.call.mockResolvedValue(makeValidResponse());

      const layer = new StrategicLayer(deps);
      layer.start();

      await waitFor(() => mockAdapter.call.mock.calls.length >= 1, 60_000);
      layer.stop();

      const userMsg = mockAdapter.call.mock.calls[0][1];
      expect(userMsg).toContain('creeper');
      expect(userMsg).toContain('クリーパーに注意');
    }, 65_000);
  });

  describe('システムプロンプト', () => {
    it('キャラクター定義と出力フォーマットを含む', () => {
      const layer = new StrategicLayer(deps);
      const prompt = (layer as any).buildSystemPrompt();

      expect(prompt).toContain('星守レイ');
      expect(prompt).toContain('main_goal');
      expect(prompt).toContain('sub_goals');
    });
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
