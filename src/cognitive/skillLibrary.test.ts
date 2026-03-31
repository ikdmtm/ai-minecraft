import Database from 'better-sqlite3';
import { SkillLibrary } from './skillLibrary';

describe('SkillLibrary', () => {
  let db: Database.Database;
  let lib: SkillLibrary;

  beforeEach(() => {
    db = new Database(':memory:');
    lib = new SkillLibrary(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('スキル登録', () => {
    it('新しいスキルを保存できる', () => {
      lib.addSkill({
        name: '夜間シェルター',
        description: '夜に穴を掘って安全に待機する',
        context: 'night_survival',
        steps: ['地面に3ブロック掘る', '上に蓋をする', '朝まで待つ'],
        successCount: 1,
        failCount: 0,
      });

      const skills = lib.getAllSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('夜間シェルター');
      expect(skills[0].steps).toEqual(['地面に3ブロック掘る', '上に蓋をする', '朝まで待つ']);
    });

    it('同名スキルは上書きされる', () => {
      lib.addSkill({
        name: 'テスト',
        description: 'v1',
        context: 'test',
        steps: ['step1'],
        successCount: 1,
        failCount: 0,
      });
      lib.addSkill({
        name: 'テスト',
        description: 'v2',
        context: 'test',
        steps: ['step1', 'step2'],
        successCount: 2,
        failCount: 0,
      });

      const skills = lib.getAllSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].description).toBe('v2');
      expect(skills[0].successCount).toBe(2);
    });
  });

  describe('スキル検索', () => {
    beforeEach(() => {
      lib.addSkill({
        name: '木の伐採',
        description: '周辺の木を効率的に伐採する手順',
        context: 'resource_gathering',
        steps: ['近くの木を見つける', 'pathfind', '伐採'],
        successCount: 5,
        failCount: 1,
      });
      lib.addSkill({
        name: '鉄鉱石採掘',
        description: '洞窟で鉄鉱石を探して採掘する',
        context: 'mining',
        steps: ['洞窟を見つける', '鉄鉱石を探す', '採掘'],
        successCount: 3,
        failCount: 0,
      });
      lib.addSkill({
        name: '夜間シェルター',
        description: '夜に安全な穴を掘って待機',
        context: 'night_survival',
        steps: ['穴を掘る', '蓋をする'],
        successCount: 10,
        failCount: 0,
      });
    });

    it('コンテキストで検索できる', () => {
      const results = lib.findByContext('mining');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('鉄鉱石採掘');
    });

    it('キーワードで検索できる', () => {
      const results = lib.search('木');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('木の伐採');
    });

    it('複数キーワードで検索できる', () => {
      const results = lib.search('採掘');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('鉄鉱石採掘');
    });

    it('成功率でソートされた上位スキルを取得できる', () => {
      const top = lib.getTopSkills(2);
      expect(top).toHaveLength(2);
      expect(top[0].name).toBe('夜間シェルター');
    });

    it('存在しないコンテキストは空配列を返す', () => {
      expect(lib.findByContext('nonexistent')).toEqual([]);
    });
  });

  describe('スキル更新', () => {
    it('成功カウントを増やせる', () => {
      lib.addSkill({
        name: 'テスト',
        description: 'test',
        context: 'test',
        steps: ['s1'],
        successCount: 0,
        failCount: 0,
      });

      lib.recordSuccess('テスト');
      lib.recordSuccess('テスト');

      const skill = lib.getAllSkills()[0];
      expect(skill.successCount).toBe(2);
    });

    it('失敗カウントを増やせる', () => {
      lib.addSkill({
        name: 'テスト',
        description: 'test',
        context: 'test',
        steps: ['s1'],
        successCount: 0,
        failCount: 0,
      });

      lib.recordFailure('テスト');

      const skill = lib.getAllSkills()[0];
      expect(skill.failCount).toBe(1);
    });

    it('存在しないスキルの更新は例外を投げない', () => {
      expect(() => lib.recordSuccess('不明')).not.toThrow();
      expect(() => lib.recordFailure('不明')).not.toThrow();
    });
  });

  describe('サマリー取得', () => {
    it('getSummaries はスキル名と説明の配列を返す', () => {
      lib.addSkill({
        name: '木の伐採',
        description: '木を効率的に伐採',
        context: 'resource',
        steps: ['s1'],
        successCount: 3,
        failCount: 1,
      });

      const summaries = lib.getSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain('木の伐採');
      expect(summaries[0]).toContain('3');
    });
  });

  describe('スキル削除', () => {
    it('名前でスキルを削除できる', () => {
      lib.addSkill({
        name: '削除テスト',
        description: 'test',
        context: 'test',
        steps: ['s1'],
        successCount: 0,
        failCount: 0,
      });

      lib.removeSkill('削除テスト');
      expect(lib.getAllSkills()).toHaveLength(0);
    });
  });
});
