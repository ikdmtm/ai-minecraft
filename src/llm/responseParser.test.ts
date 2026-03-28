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

  it('returns error for broken JSON (truncated by max_tokens)', () => {
    const truncated = '{"action":{"goal":"拠点に戻る","reason":"夜だ","steps":["帰';
    const result = parseResponse(truncated);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('パース');
  });

  it('returns error for empty commentary', () => {
    const raw = JSON.stringify({
      action: { goal: 'g', reason: 'r', steps: ['s'] },
      commentary: '',
      current_goal_update: null,
      threat_level: 'low',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(false);
  });

  it('returns error for empty goal', () => {
    const raw = JSON.stringify({
      action: { goal: '', reason: 'r', steps: ['s'] },
      commentary: 'c',
      current_goal_update: null,
      threat_level: 'low',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(false);
  });

  it('returns error for whitespace-only input', () => {
    const result = parseResponse('   \n\t  ');
    expect(result.ok).toBe(false);
  });
});

describe('parseResponse - LLM edge cases', () => {
  it('handles JSON with text before it', () => {
    const raw = 'はい、以下がレスポンスです：\n\n' + JSON.stringify({
      action: { goal: 'g', reason: 'r', steps: ['s'] },
      commentary: 'c',
      current_goal_update: null,
      threat_level: 'low',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(false);
  });

  it('handles JSON inside code block with surrounding text', () => {
    const json = JSON.stringify({
      action: { goal: '木を伐る', reason: '資材不足', steps: ['木を探す', '伐採する'] },
      commentary: 'まずは木だ。',
      current_goal_update: null,
      threat_level: 'low',
    });
    const raw = `分析しました。以下がレスポンスです：\n\n\`\`\`json\n${json}\n\`\`\`\n\nこれで良いでしょうか？`;
    const result = parseResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.action.goal).toBe('木を伐る');
  });

  it('handles missing current_goal_update field (LLM omits it)', () => {
    const raw = JSON.stringify({
      action: { goal: 'g', reason: 'r', steps: ['s'] },
      commentary: 'c',
      threat_level: 'low',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.currentGoalUpdate).toBeNull();
  });

  it('handles extra fields from LLM (should be ignored)', () => {
    const raw = JSON.stringify({
      action: { goal: 'g', reason: 'r', steps: ['s'] },
      commentary: 'c',
      current_goal_update: null,
      threat_level: 'low',
      confidence: 0.95,
      internal_reasoning: 'extra field',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(true);
  });

  it('handles steps with numbers in them', () => {
    const raw = JSON.stringify({
      action: { goal: 'g', reason: 'r', steps: ['1. 木を伐る', '2. 拠点に戻る'] },
      commentary: 'c',
      current_goal_update: null,
      threat_level: 'low',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.action.steps[0]).toBe('1. 木を伐る');
  });

  it('handles Japanese in all threat levels', () => {
    for (const level of ['low', 'medium', 'high', 'critical'] as const) {
      const raw = JSON.stringify({
        action: { goal: 'g', reason: 'r', steps: ['s'] },
        commentary: 'c',
        current_goal_update: null,
        threat_level: level,
      });
      const result = parseResponse(raw);
      expect(result.ok).toBe(true);
    }
  });

  it('rejects threat_level with wrong case', () => {
    const raw = JSON.stringify({
      action: { goal: 'g', reason: 'r', steps: ['s'] },
      commentary: 'c',
      current_goal_update: null,
      threat_level: 'LOW',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(false);
  });

  it('handles very long commentary from LLM', () => {
    const raw = JSON.stringify({
      action: { goal: 'g', reason: 'r', steps: ['s'] },
      commentary: 'あ'.repeat(5000),
      current_goal_update: null,
      threat_level: 'low',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(true);
  });

  it('handles many steps from LLM', () => {
    const raw = JSON.stringify({
      action: { goal: 'g', reason: 'r', steps: Array.from({ length: 20 }, (_, i) => `ステップ${i + 1}`) },
      commentary: 'c',
      current_goal_update: null,
      threat_level: 'low',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.action.steps).toHaveLength(20);
  });

  it('handles emoji in commentary', () => {
    const raw = JSON.stringify({
      action: { goal: 'g', reason: 'r', steps: ['s'] },
      commentary: '危ない！🔥クリーパーだ！💀',
      current_goal_update: null,
      threat_level: 'critical',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(true);
  });
});
