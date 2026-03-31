import Database from 'better-sqlite3';
import { EpisodicMemory } from './memory';
import type { EpisodeSummary, LifetimeMemory } from './memory';

describe('EpisodicMemory', () => {
  let db: Database.Database;
  let mem: EpisodicMemory;

  beforeEach(() => {
    db = new Database(':memory:');
    mem = new EpisodicMemory(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('エピソード保存', () => {
    it('世代の要約を保存できる', () => {
      mem.saveEpisode({
        generation: 1,
        survivalMinutes: 12.5,
        deathCause: 'creeper',
        lessons: ['クリーパーの音に注意する', '夜は外出しない'],
        achievements: ['木のツルハシ作成', '石のツルハシ作成'],
        emotionalSummary: '最初は不安だったが、少し慣れてきた矢先にやられた',
      });

      const episodes = mem.getRecentEpisodes(5);
      expect(episodes).toHaveLength(1);
      expect(episodes[0].generation).toBe(1);
      expect(episodes[0].deathCause).toBe('creeper');
      expect(episodes[0].lessons).toContain('クリーパーの音に注意する');
    });

    it('複数世代の要約を保存し、新しい順に取得できる', () => {
      for (let i = 1; i <= 5; i++) {
        mem.saveEpisode({
          generation: i,
          survivalMinutes: i * 10,
          deathCause: `cause_${i}`,
          lessons: [`lesson_${i}`],
          achievements: [],
          emotionalSummary: '',
        });
      }

      const recent = mem.getRecentEpisodes(3);
      expect(recent).toHaveLength(3);
      expect(recent[0].generation).toBe(5);
      expect(recent[2].generation).toBe(3);
    });
  });

  describe('教訓の集約', () => {
    it('全世代の教訓を重複排除して取得できる', () => {
      mem.saveEpisode({
        generation: 1,
        survivalMinutes: 5,
        deathCause: 'fall',
        lessons: ['高所に注意', '夜は外に出ない'],
        achievements: [],
        emotionalSummary: '',
      });
      mem.saveEpisode({
        generation: 2,
        survivalMinutes: 8,
        deathCause: 'zombie',
        lessons: ['夜は外に出ない', '武器を持ち歩く'],
        achievements: [],
        emotionalSummary: '',
      });

      const lessons = mem.getAccumulatedLessons();
      expect(lessons).toContain('高所に注意');
      expect(lessons).toContain('夜は外に出ない');
      expect(lessons).toContain('武器を持ち歩く');
      // 重複排除
      expect(lessons.filter(l => l === '夜は外に出ない')).toHaveLength(1);
    });
  });

  describe('ライフタイムメモリ', () => {
    it('統計情報を取得できる', () => {
      mem.saveEpisode({
        generation: 1, survivalMinutes: 5, deathCause: 'fall',
        lessons: [], achievements: ['木のツルハシ'], emotionalSummary: '',
      });
      mem.saveEpisode({
        generation: 2, survivalMinutes: 15, deathCause: 'creeper',
        lessons: [], achievements: ['鉄のツルハシ'], emotionalSummary: '',
      });

      const lifetime = mem.getLifetimeMemory();
      expect(lifetime.totalDeaths).toBe(2);
      expect(lifetime.bestSurvivalMinutes).toBe(15);
      expect(lifetime.averageSurvivalMinutes).toBe(10);
      expect(lifetime.topDeathCauses).toContainEqual({ cause: 'fall', count: 1 });
      expect(lifetime.topDeathCauses).toContainEqual({ cause: 'creeper', count: 1 });
    });

    it('エピソードがない場合のデフォルト値', () => {
      const lifetime = mem.getLifetimeMemory();
      expect(lifetime.totalDeaths).toBe(0);
      expect(lifetime.bestSurvivalMinutes).toBe(0);
      expect(lifetime.averageSurvivalMinutes).toBe(0);
    });
  });

  describe('短期記憶', () => {
    it('短期メモを保存・取得できる', () => {
      mem.saveShortTermNote('ここに鉄鉱石がある');
      mem.saveShortTermNote('北に村がありそう');

      const notes = mem.getShortTermNotes(10);
      expect(notes).toHaveLength(2);
      expect(notes[0]).toBe('北に村がありそう');
    });

    it('制限数を超えた場合は最新のみ返す', () => {
      for (let i = 0; i < 20; i++) {
        mem.saveShortTermNote(`note_${i}`);
      }
      const notes = mem.getShortTermNotes(5);
      expect(notes).toHaveLength(5);
      expect(notes[0]).toBe('note_19');
    });
  });

  describe('プロンプト用コンテキスト生成', () => {
    it('buildMemoryContext で LLM 向けの文字列を生成できる', () => {
      mem.saveEpisode({
        generation: 1, survivalMinutes: 5, deathCause: 'creeper',
        lessons: ['クリーパーに注意'], achievements: ['木のツルハシ'],
        emotionalSummary: '不安だった',
      });

      const ctx = mem.buildMemoryContext(3);
      expect(ctx).toContain('creeper');
      expect(ctx).toContain('クリーパーに注意');
      expect(ctx).toContain('木のツルハシ');
    });

    it('エピソードが空でもエラーにならない', () => {
      const ctx = mem.buildMemoryContext(3);
      expect(typeof ctx).toBe('string');
    });
  });
});
