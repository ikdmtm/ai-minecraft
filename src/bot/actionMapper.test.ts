import { mapStep, mapSteps } from './actionMapper';

describe('mapStep', () => {
  it('maps "拠点へ帰還する" to move_to_position', () => {
    const result = mapStep('拠点へ帰還する');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('move_to_position');
      expect(result.value.params.target).toBe('base');
    }
  });

  it('maps "拠点に戻る" to move_to_position', () => {
    const result = mapStep('拠点に戻る');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.type).toBe('move_to_position');
  });

  it('maps "鉄鉱石を採掘する" to mine_block', () => {
    const result = mapStep('鉄鉱石を採掘する');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('mine_block');
      expect(result.value.params.blockType).toBe('iron_ore');
    }
  });

  it('maps "木を伐採する" to mine_block with oak_log', () => {
    const result = mapStep('木を伐採する');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('mine_block');
      expect(result.value.params.blockType).toBe('oak_log');
    }
  });

  it('maps "ベッドで寝る" to sleep', () => {
    const result = mapStep('ベッドで寝る');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.type).toBe('sleep');
  });

  it('maps "食料を食べる" to eat_food', () => {
    const result = mapStep('食料を食べる');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.type).toBe('eat_food');
  });

  it('maps "かまどで精錬する" to smelt_item', () => {
    const result = mapStep('かまどで精錬する');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.type).toBe('smelt_item');
  });

  it('maps "周辺を探索する" to explore', () => {
    const result = mapStep('周辺を探索する');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.type).toBe('explore');
  });

  it('maps "洞窟に入る" to explore with cave', () => {
    const result = mapStep('洞窟に入る');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('explore');
      expect(result.value.params.variant).toBe('cave');
    }
  });

  it('maps "ダイヤモンドを掘る" to mine_block', () => {
    const result = mapStep('ダイヤモンドを掘る');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('mine_block');
      expect(result.value.params.blockType).toBe('diamond_ore');
    }
  });

  it('maps "石炭を採掘する" to mine_block', () => {
    const result = mapStep('石炭を採掘する');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.params.blockType).toBe('coal_ore');
  });

  it('maps crafting-related steps to craft_item', () => {
    expect(mapStep('作業台でツルハシを作る').ok && mapStep('作業台でツルハシを作る').ok).toBe(true);
    const r = mapStep('作業台でツルハシを作る');
    if (r.ok) expect(r.value.type).toBe('craft_item');
  });

  it('preserves original step text', () => {
    const result = mapStep('拠点へ帰還する');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.originalStep).toBe('拠点へ帰還する');
  });

  it('returns error for unmappable step', () => {
    const result = mapStep('宇宙に飛んでいく');
    expect(result.ok).toBe(false);
  });
});

describe('mapSteps', () => {
  it('maps an array of steps, skipping unmappable ones', () => {
    const steps = [
      '拠点へ帰還する',
      '宇宙に飛んでいく',
      'ベッドで寝る',
    ];
    const results = mapSteps(steps);
    expect(results).toHaveLength(2);
    expect(results[0].type).toBe('move_to_position');
    expect(results[1].type).toBe('sleep');
  });

  it('returns empty array for all unmappable steps', () => {
    const results = mapSteps(['意味不明な行動', 'ランダムな文字列']);
    expect(results).toHaveLength(0);
  });
});
