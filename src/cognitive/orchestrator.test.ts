import { CognitiveOrchestrator } from './orchestrator';
import { SharedStateBus } from './sharedState';
import type { CognitiveOrchestratorConfig } from './orchestrator';

describe('CognitiveOrchestrator', () => {
  let shared: SharedStateBus;

  beforeEach(() => {
    shared = new SharedStateBus();
  });

  describe('初期化', () => {
    it('SharedStateBus を正しく初期化する', () => {
      const config = makeConfig();
      const orch = new CognitiveOrchestrator(config);

      expect(orch.getShared().get().generation).toBe(1);
      expect(orch.isRunning()).toBe(false);
    });
  });

  describe('世代管理', () => {
    it('nextGeneration で世代をインクリメントし状態をリセットする', () => {
      const config = makeConfig();
      const orch = new CognitiveOrchestrator(config);

      orch.getShared().setGoal('テスト目標');
      orch.getShared().setThreatLevel('danger');
      orch.nextGeneration();

      expect(orch.getShared().get().generation).toBe(2);
      expect(orch.getShared().get().currentGoal).toBe('');
      expect(orch.getShared().get().threatLevel).toBe('safe');
    });
  });

  describe('LLM アダプター生成', () => {
    it('Haiku 用と Sonnet 用の 2 つの LLM アダプターを区別する', () => {
      const config = makeConfig();
      const orch = new CognitiveOrchestrator(config);

      expect(config.tacticalModel).toBe('claude-haiku-4-20250414');
      expect(config.strategicModel).toBe('claude-sonnet-4-20250514');
    });
  });
});

function makeConfig(): CognitiveOrchestratorConfig {
  return {
    anthropicApiKey: 'test-key',
    tacticalModel: 'claude-haiku-4-20250414',
    strategicModel: 'claude-sonnet-4-20250514',
    mcHost: 'localhost',
    mcPort: 25565,
    botUsername: 'AI_Rei',
    cameraPlayer: 'StreamCamera',
    voicevoxHost: 'http://localhost:50021',
    voicevoxSpeakerId: 14,
    dbPath: ':memory:',
  };
}
