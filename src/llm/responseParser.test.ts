import { parseResponse } from './responseParser';

const VALID_RESPONSE = JSON.stringify({
  action: {
    goal: '拠点に戻って就寝する',
    reason: '夜になりゾンビが近くにいる',
    steps: ['拠点へ帰還する', 'ベッドで寝る'],
  },
  commentary: 'ゾンビの気配がする。拠点に戻ろう。',
  current_goal_update: null,
  threat_level: 'medium',
});

describe('parseResponse - valid', () => {
  it('parses a valid response', () => {
    const result = parseResponse(VALID_RESPONSE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.action.goal).toBe('拠点に戻って就寝する');
    expect(result.value.action.steps).toHaveLength(2);
    expect(result.value.commentary).toBe('ゾンビの気配がする。拠点に戻ろう。');
    expect(result.value.threatLevel).toBe('medium');
    expect(result.value.currentGoalUpdate).toBeNull();
  });

  it('parses response with current_goal_update', () => {
    const raw = JSON.stringify({
      action: { goal: 'g', reason: 'r', steps: ['s'] },
      commentary: 'c',
      current_goal_update: 'ネザーを目指す',
      threat_level: 'low',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.currentGoalUpdate).toBe('ネザーを目指す');
  });

  it('extracts JSON from markdown code block', () => {
    const wrapped = '```json\n' + VALID_RESPONSE + '\n```';
    const result = parseResponse(wrapped);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.action.goal).toBe('拠点に戻って就寝する');
  });

  it('extracts JSON from plain code block', () => {
    const wrapped = '```\n' + VALID_RESPONSE + '\n```';
    const result = parseResponse(wrapped);
    expect(result.ok).toBe(true);
  });

  it('handles extra whitespace', () => {
    const result = parseResponse('  \n' + VALID_RESPONSE + '\n  ');
    expect(result.ok).toBe(true);
  });
});

describe('parseResponse - invalid', () => {
  it('returns error for non-JSON', () => {
    const result = parseResponse('これはJSONではありません');
    expect(result.ok).toBe(false);
  });

  it('returns error for missing action', () => {
    const raw = JSON.stringify({
      commentary: 'c',
      threat_level: 'low',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(false);
  });

  it('returns error for missing action.goal', () => {
    const raw = JSON.stringify({
      action: { reason: 'r', steps: ['s'] },
      commentary: 'c',
      threat_level: 'low',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(false);
  });

  it('returns error for missing action.steps', () => {
    const raw = JSON.stringify({
      action: { goal: 'g', reason: 'r' },
      commentary: 'c',
      threat_level: 'low',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(false);
  });

  it('returns error for empty steps array', () => {
    const raw = JSON.stringify({
      action: { goal: 'g', reason: 'r', steps: [] },
      commentary: 'c',
      threat_level: 'low',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(false);
  });

  it('returns error for missing commentary', () => {
    const raw = JSON.stringify({
      action: { goal: 'g', reason: 'r', steps: ['s'] },
      threat_level: 'low',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(false);
  });

  it('returns error for invalid threat_level', () => {
    const raw = JSON.stringify({
      action: { goal: 'g', reason: 'r', steps: ['s'] },
      commentary: 'c',
      threat_level: 'invalid',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(false);
  });

  it('returns error for empty string', () => {
    const result = parseResponse('');
    expect(result.ok).toBe(false);
  });
});
