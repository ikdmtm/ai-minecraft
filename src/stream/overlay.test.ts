import {
  formatSurvivalTime,
  buildOverlayData,
  type OverlayInput,
} from './overlay';

describe('formatSurvivalTime', () => {
  it('formats 0 minutes', () => expect(formatSurvivalTime(0)).toBe('0:00'));
  it('formats 5 minutes', () => expect(formatSurvivalTime(5)).toBe('0:05'));
  it('formats 59 minutes', () => expect(formatSurvivalTime(59)).toBe('0:59'));
  it('formats 60 minutes', () => expect(formatSurvivalTime(60)).toBe('1:00'));
  it('formats 90 minutes', () => expect(formatSurvivalTime(90)).toBe('1:30'));
  it('formats 240 minutes', () => expect(formatSurvivalTime(240)).toBe('4:00'));
  it('formats 1440 minutes (1 day)', () => expect(formatSurvivalTime(1440)).toBe('24:00'));
});

describe('buildOverlayData', () => {
  const baseInput: OverlayInput = {
    survivalTimeMinutes: 87,
    bestRecordMinutes: 240,
    currentGoal: '鉄装備を完成させる',
    threatLevel: 'medium',
    commentary: 'ゾンビの気配がする。拠点に戻ろう。',
    generation: 5,
  };

  it('builds formatted survival time', () => {
    const data = buildOverlayData(baseInput);
    expect(data.survivalTime).toBe('1:27');
  });

  it('builds formatted best record', () => {
    const data = buildOverlayData(baseInput);
    expect(data.bestRecord).toBe('4:00');
  });

  it('includes generation number', () => {
    const data = buildOverlayData(baseInput);
    expect(data.generation).toBe('Gen #5');
  });

  it('maps threat level to color', () => {
    expect(buildOverlayData({ ...baseInput, threatLevel: 'low' }).threatColor).toBe('#4CAF50');
    expect(buildOverlayData({ ...baseInput, threatLevel: 'medium' }).threatColor).toBe('#FF9800');
    expect(buildOverlayData({ ...baseInput, threatLevel: 'high' }).threatColor).toBe('#F44336');
    expect(buildOverlayData({ ...baseInput, threatLevel: 'critical' }).threatColor).toBe('#D32F2F');
  });

  it('maps threat level to label', () => {
    expect(buildOverlayData({ ...baseInput, threatLevel: 'low' }).threatLabel).toBe('安全');
    expect(buildOverlayData({ ...baseInput, threatLevel: 'medium' }).threatLabel).toBe('注意');
    expect(buildOverlayData({ ...baseInput, threatLevel: 'high' }).threatLabel).toBe('危険');
    expect(buildOverlayData({ ...baseInput, threatLevel: 'critical' }).threatLabel).toBe('致命的');
  });

  it('truncates long commentary', () => {
    const longText = 'あ'.repeat(200);
    const data = buildOverlayData({ ...baseInput, commentary: longText });
    expect(data.commentary.length).toBe(100);
    expect(data.commentary.endsWith('…')).toBe(true);
  });

  it('keeps short commentary as-is', () => {
    const data = buildOverlayData(baseInput);
    expect(data.commentary).toBe('ゾンビの気配がする。拠点に戻ろう。');
  });

  it('handles empty commentary', () => {
    const data = buildOverlayData({ ...baseInput, commentary: '' });
    expect(data.commentary).toBe('');
  });
});
