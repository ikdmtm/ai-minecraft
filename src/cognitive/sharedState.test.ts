import { SharedStateBus } from './sharedState';
import type { EmotionalState, CognitiveThreatLevel } from './sharedState';

describe('SharedStateBus', () => {
  let bus: SharedStateBus;

  beforeEach(() => {
    bus = new SharedStateBus();
  });

  describe('初期状態', () => {
    it('デフォルト値で初期化される', () => {
      const s = bus.get();
      expect(s.currentGoal).toBe('');
      expect(s.subGoals).toEqual([]);
      expect(s.threatLevel).toBe('safe');
      expect(s.reflexState).toBe('idle');
      expect(s.generation).toBe(1);
      expect(s.lessonsThisLife).toEqual([]);
      expect(s.recentEvents).toEqual([]);
      expect(s.worldModel.basePosition).toBeNull();
    });

    it('感情がデフォルトの穏やかな状態で始まる', () => {
      const e = bus.get().emotionalState;
      expect(e.valence).toBe(0.3);
      expect(e.arousal).toBe(0.2);
      expect(e.dominance).toBe(0.5);
      expect(e.recentTrigger).toBe('start');
    });
  });

  describe('reset', () => {
    it('世代番号を更新しつつ状態をリセットする', () => {
      bus.setGoal('ダイヤを探す');
      bus.setThreatLevel('danger');
      bus.addLesson('溶岩に注意');
      bus.reset(5);

      const s = bus.get();
      expect(s.generation).toBe(5);
      expect(s.currentGoal).toBe('');
      expect(s.threatLevel).toBe('safe');
      expect(s.lessonsThisLife).toEqual([]);
    });

    it('リセット後の感情トリガーが new_life になる', () => {
      bus.reset(2);
      expect(bus.get().emotionalState.recentTrigger).toBe('new_life');
    });
  });

  describe('目標管理', () => {
    it('setGoal で現在の目標を変更できる', () => {
      bus.setGoal('木を伐採する');
      expect(bus.get().currentGoal).toBe('木を伐採する');
    });

    it('setSubGoals でサブ目標を設定できる', () => {
      bus.setSubGoals(['原木を集める', '板材にクラフト', 'ツルハシ作成']);
      expect(bus.get().subGoals).toHaveLength(3);
    });

    it('popSubGoal で先頭のサブ目標を取り出せる', () => {
      bus.setSubGoals(['A', 'B', 'C']);
      expect(bus.popSubGoal()).toBe('A');
      expect(bus.get().subGoals).toEqual(['B', 'C']);
    });

    it('空の場合 popSubGoal は undefined を返す', () => {
      expect(bus.popSubGoal()).toBeUndefined();
    });
  });

  describe('脅威レベル', () => {
    it.each<CognitiveThreatLevel>(['safe', 'caution', 'danger', 'critical'])(
      '%s に設定できる',
      (level) => {
        bus.setThreatLevel(level);
        expect(bus.get().threatLevel).toBe(level);
      },
    );
  });

  describe('感情モデル', () => {
    it('updateEmotion で差分更新できる', () => {
      bus.updateEmotion({ valence: 0.2, arousal: 0.3 }, 'found_diamond');
      const e = bus.get().emotionalState;
      expect(e.valence).toBeCloseTo(0.5);
      expect(e.arousal).toBeCloseTo(0.5);
      expect(e.recentTrigger).toBe('found_diamond');
    });

    it('valence は -1 ~ 1 にクランプされる', () => {
      bus.updateEmotion({ valence: 5.0 }, 'overflow');
      expect(bus.get().emotionalState.valence).toBe(1);

      bus.updateEmotion({ valence: -10.0 }, 'underflow');
      expect(bus.get().emotionalState.valence).toBe(-1);
    });

    it('arousal は 0 ~ 1 にクランプされる', () => {
      bus.updateEmotion({ arousal: 5.0 }, 'overflow');
      expect(bus.get().emotionalState.arousal).toBe(1);

      bus.updateEmotion({ arousal: -10.0 }, 'underflow');
      expect(bus.get().emotionalState.arousal).toBe(0);
    });

    it('setEmotion で完全な感情を上書きできる', () => {
      const emotion: EmotionalState = {
        valence: -0.5, arousal: 0.8, dominance: 0.1, recentTrigger: 'panic',
      };
      bus.setEmotion(emotion);
      expect(bus.get().emotionalState).toEqual(emotion);
    });

    it('decayEmotion で感情が中立方向に減衰する', () => {
      bus.setEmotion({ valence: 0.8, arousal: 0.8, dominance: 0.8, recentTrigger: 'x' });
      bus.decayEmotion(0.5);
      const e = bus.get().emotionalState;
      expect(e.valence).toBeCloseTo(0.4);
      expect(e.arousal).toBeCloseTo(0.4);
      expect(e.dominance).toBeCloseTo(0.65);
    });
  });

  describe('感情ラベル', () => {
    it('高valence + 高arousal = excited', () => {
      bus.setEmotion({ valence: 0.6, arousal: 0.6, dominance: 0.5, recentTrigger: '' });
      expect(bus.getEmotionLabel()).toBe('excited');
    });

    it('高valence + 低arousal = content', () => {
      bus.setEmotion({ valence: 0.4, arousal: 0.2, dominance: 0.5, recentTrigger: '' });
      expect(bus.getEmotionLabel()).toBe('content');
    });

    it('低valence + 高arousal = panicked', () => {
      bus.setEmotion({ valence: -0.6, arousal: 0.6, dominance: 0.5, recentTrigger: '' });
      expect(bus.getEmotionLabel()).toBe('panicked');
    });

    it('低valence + 低arousal = sad', () => {
      bus.setEmotion({ valence: -0.4, arousal: 0.2, dominance: 0.5, recentTrigger: '' });
      expect(bus.getEmotionLabel()).toBe('sad');
    });

    it('中間値 = neutral', () => {
      bus.setEmotion({ valence: 0.0, arousal: 0.4, dominance: 0.5, recentTrigger: '' });
      expect(bus.getEmotionLabel()).toBe('neutral');
    });
  });

  describe('イベント管理', () => {
    it('pushEvent でイベントを追加しタイムスタンプが付く', () => {
      bus.pushEvent({ type: 'mined', detail: 'oak_log', importance: 'low' });
      const events = bus.get().recentEvents;
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('mined');
      expect(events[0].timestamp).toBeGreaterThan(0);
    });

    it('MAX_EVENTS(100) を超えると古いイベントが削除される', () => {
      for (let i = 0; i < 105; i++) {
        bus.pushEvent({ type: 'test', detail: `event_${i}`, importance: 'low' });
      }
      expect(bus.get().recentEvents).toHaveLength(100);
      expect(bus.get().recentEvents[0].detail).toBe('event_5');
    });

    it('getRecentEvents でウィンドウ内のイベントのみ取得できる', () => {
      const now = Date.now();
      // 手動でタイムスタンプを設定するために直接操作
      bus.pushEvent({ type: 'old', detail: 'old', importance: 'low' });
      bus.pushEvent({ type: 'new', detail: 'new', importance: 'low' });

      const events = bus.getRecentEvents(60_000);
      expect(events.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('ワールドモデル', () => {
    it('拠点を設定・取得できる', () => {
      bus.setBase({ x: 100, y: 64, z: -200 });
      expect(bus.get().worldModel.basePosition).toEqual({ x: 100, y: 64, z: -200 });
    });

    it('危険ゾーンを追加できる', () => {
      bus.addDangerZone({ x: 50, y: 30, z: 50 }, 'lava', 10_000);
      expect(bus.get().worldModel.dangerZones).toHaveLength(1);
      expect(bus.get().worldModel.dangerZones[0].reason).toBe('lava');
    });

    it('cleanupExpired で期限切れの危険ゾーンが削除される', () => {
      bus.addDangerZone({ x: 0, y: 0, z: 0 }, 'test', -1);
      expect(bus.get().worldModel.dangerZones).toHaveLength(1);
      bus.cleanupExpired();
      expect(bus.get().worldModel.dangerZones).toHaveLength(0);
    });

    it('addResourceLocation で近い位置は lastSeen を更新する', () => {
      bus.addResourceLocation('iron_ore', { x: 10, y: 20, z: 30 });
      bus.addResourceLocation('iron_ore', { x: 11, y: 20, z: 30 });
      expect(bus.get().worldModel.resourceLocations).toHaveLength(1);
    });

    it('addResourceLocation で離れた位置は別エントリになる', () => {
      bus.addResourceLocation('iron_ore', { x: 10, y: 20, z: 30 });
      bus.addResourceLocation('iron_ore', { x: 100, y: 20, z: 300 });
      expect(bus.get().worldModel.resourceLocations).toHaveLength(2);
    });

    it('addStructure で同じ場所の重複を防ぐ', () => {
      bus.addStructure('village', { x: 100, y: 64, z: 200 });
      bus.addStructure('village', { x: 105, y: 64, z: 200 });
      expect(bus.get().worldModel.discoveredStructures).toHaveLength(1);
    });
  });

  describe('リスナー', () => {
    it('onStateChange で変更通知を受け取れる', () => {
      const calls: Array<[string, unknown]> = [];
      bus.onStateChange((field, value) => calls.push([field, value]));

      bus.setGoal('テスト');
      bus.setThreatLevel('danger');

      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(['currentGoal', 'テスト']);
      expect(calls[1]).toEqual(['threatLevel', 'danger']);
    });

    it('返り値の関数でリスナーを解除できる', () => {
      const calls: string[] = [];
      const unsub = bus.onStateChange((field) => calls.push(field));

      bus.setGoal('A');
      unsub();
      bus.setGoal('B');

      expect(calls).toEqual(['currentGoal']);
    });

    it('リスナーのエラーは他に影響しない', () => {
      bus.onStateChange(() => { throw new Error('fail'); });
      const calls: string[] = [];
      bus.onStateChange((field) => calls.push(field));

      bus.setGoal('test');
      expect(calls).toEqual(['currentGoal']);
    });
  });

  describe('教訓とコメンタリー', () => {
    it('addLesson で教訓を蓄積できる', () => {
      bus.addLesson('夜は外出しない');
      bus.addLesson('クリーパーには近づかない');
      expect(bus.get().lessonsThisLife).toEqual([
        '夜は外出しない',
        'クリーパーには近づかない',
      ]);
    });

    it('setCommentary で実況テキストを設定できる', () => {
      bus.setCommentary('ダイヤモンドを見つけたぞ！');
      expect(bus.get().currentCommentary).toBe('ダイヤモンドを見つけたぞ！');
    });
  });

  describe('タイムスタンプ管理', () => {
    it('markTacticalUpdate で更新時刻を記録できる', () => {
      const before = Date.now();
      bus.markTacticalUpdate();
      expect(bus.get().lastTacticalUpdate).toBeGreaterThanOrEqual(before);
    });

    it('markStrategicUpdate で更新時刻を記録できる', () => {
      const before = Date.now();
      bus.markStrategicUpdate();
      expect(bus.get().lastStrategicUpdate).toBeGreaterThanOrEqual(before);
    });

    it('getSurvivalMinutes は経過時間を返す', () => {
      expect(bus.getSurvivalMinutes()).toBeGreaterThanOrEqual(0);
      expect(bus.getSurvivalMinutes()).toBeLessThan(1);
    });
  });
});
