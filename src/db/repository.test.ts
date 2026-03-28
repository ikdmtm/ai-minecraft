import { Repository } from './repository';
import { openInMemoryDatabase } from './database';
import { runMigrations } from './schema';
import type Database from 'better-sqlite3';
import type { DeathRecord } from '../types/gameState';

let db: Database.Database;
let repo: Repository;

beforeEach(() => {
  db = openInMemoryDatabase();
  runMigrations(db);
  repo = new Repository(db);
});

afterEach(() => {
  db.close();
});

describe('Repository - State', () => {
  it('returns default state when empty', () => {
    const state = repo.getState();
    expect(state.currentState).toBe('IDLE');
    expect(state.currentGeneration).toBe(0);
    expect(state.bestRecordMinutes).toBe(0);
    expect(state.operationMode).toBe('MANUAL');
  });

  it('saves and retrieves partial state', () => {
    repo.saveState({ currentGeneration: 5, bestRecordMinutes: 120 });
    const state = repo.getState();
    expect(state.currentGeneration).toBe(5);
    expect(state.bestRecordMinutes).toBe(120);
    expect(state.currentState).toBe('IDLE');
  });

  it('overwrites existing state keys', () => {
    repo.saveState({ currentGeneration: 1 });
    repo.saveState({ currentGeneration: 2 });
    const state = repo.getState();
    expect(state.currentGeneration).toBe(2);
  });

  it('saves and retrieves string values', () => {
    repo.saveState({ currentStreamId: 'abc-123', survivalStartTime: '2026-03-28T14:00:00Z' });
    const state = repo.getState();
    expect(state.currentStreamId).toBe('abc-123');
    expect(state.survivalStartTime).toBe('2026-03-28T14:00:00Z');
  });

  it('saves null values correctly', () => {
    repo.saveState({ currentStreamId: 'abc' });
    repo.saveState({ currentStreamId: null });
    const state = repo.getState();
    expect(state.currentStreamId).toBeNull();
  });
});

describe('Repository - Death History', () => {
  const death1: DeathRecord = {
    generation: 1,
    survivalMinutes: 45,
    cause: 'クリーパー爆発',
    lesson: '夜は拠点に戻る',
  };
  const death2: DeathRecord = {
    generation: 2,
    survivalMinutes: 120,
    cause: 'スケルトンの弓',
    lesson: '洞窟では盾を持つ',
  };
  const death3: DeathRecord = {
    generation: 3,
    survivalMinutes: 15,
    cause: '溺死',
    lesson: '水中洞窟に入らない',
  };

  it('adds and retrieves death records', () => {
    repo.addDeathRecord(death1);
    const records = repo.getRecentDeaths(5);
    expect(records).toHaveLength(1);
    expect(records[0].generation).toBe(1);
    expect(records[0].cause).toBe('クリーパー爆発');
  });

  it('returns recent deaths in reverse chronological order', () => {
    repo.addDeathRecord(death1);
    repo.addDeathRecord(death2);
    repo.addDeathRecord(death3);
    const records = repo.getRecentDeaths(5);
    expect(records).toHaveLength(3);
    expect(records[0].generation).toBe(3);
    expect(records[1].generation).toBe(2);
    expect(records[2].generation).toBe(1);
  });

  it('respects the limit parameter', () => {
    repo.addDeathRecord(death1);
    repo.addDeathRecord(death2);
    repo.addDeathRecord(death3);
    const records = repo.getRecentDeaths(2);
    expect(records).toHaveLength(2);
    expect(records[0].generation).toBe(3);
  });

  it('returns best record', () => {
    repo.addDeathRecord(death1);
    repo.addDeathRecord(death2);
    repo.addDeathRecord(death3);
    expect(repo.getBestRecord()).toBe(120);
  });

  it('returns 0 when no death records', () => {
    expect(repo.getBestRecord()).toBe(0);
  });
});

describe('Repository - Action Log', () => {
  it('adds and retrieves action logs', () => {
    repo.addActionLog({
      timestamp: '2026-03-28T14:00:00Z',
      type: 'llm_response',
      content: '拠点に帰還する',
    });
    const logs = repo.getRecentLogs(10);
    expect(logs).toHaveLength(1);
    expect(logs[0].type).toBe('llm_response');
  });

  it('returns logs in reverse chronological order', () => {
    repo.addActionLog({ timestamp: '2026-03-28T14:00:00Z', type: 'llm_response', content: 'a' });
    repo.addActionLog({ timestamp: '2026-03-28T14:01:00Z', type: 'reactive_action', content: 'b' });
    const logs = repo.getRecentLogs(10);
    expect(logs[0].content).toBe('b');
    expect(logs[1].content).toBe('a');
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 20; i++) {
      repo.addActionLog({ timestamp: `t${i}`, type: 'state_change', content: `log${i}` });
    }
    const logs = repo.getRecentLogs(5);
    expect(logs).toHaveLength(5);
  });
});

describe('Repository - Config', () => {
  it('returns default config when empty', () => {
    const config = repo.getConfig();
    expect(config.operationMode).toBe('MANUAL');
    expect(config.cooldownMinutes).toBe(10);
    expect(config.llmProvider).toBe('anthropic');
  });

  it('updates and retrieves config', () => {
    repo.updateConfig({ cooldownMinutes: 20, llmModel: 'claude-opus' });
    const config = repo.getConfig();
    expect(config.cooldownMinutes).toBe(20);
    expect(config.llmModel).toBe('claude-opus');
    expect(config.operationMode).toBe('MANUAL');
  });

  it('overwrites existing config keys', () => {
    repo.updateConfig({ cooldownMinutes: 10 });
    repo.updateConfig({ cooldownMinutes: 30 });
    expect(repo.getConfig().cooldownMinutes).toBe(30);
  });
});
