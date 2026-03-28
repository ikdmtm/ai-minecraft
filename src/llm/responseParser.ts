import { z } from 'zod';
import type { LLMOutput, ThreatLevel } from '../types/llm.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';

const responseSchema = z.object({
  action: z.object({
    goal: z.string().min(1),
    reason: z.string(),
    steps: z.array(z.string()).min(1),
  }),
  commentary: z.string().min(1),
  current_goal_update: z.string().nullable().optional().default(null),
  threat_level: z.enum(['low', 'medium', 'high', 'critical']),
});

/**
 * LLM の生のテキスト応答を LLMOutput にパースする。
 * - JSON をそのまま、またはマークダウンのコードブロック内から抽出する
 * - Zod でバリデーションしてから camelCase の LLMOutput に変換する
 */
export function parseResponse(raw: string): Result<LLMOutput> {
  const jsonStr = extractJson(raw);
  if (!jsonStr) {
    return err('JSON を抽出できません');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return err('JSON パースエラー');
  }

  const validated = responseSchema.safeParse(parsed);
  if (!validated.success) {
    const messages = validated.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return err(`バリデーションエラー: ${messages}`);
  }

  const d = validated.data;
  return ok({
    action: {
      goal: d.action.goal,
      reason: d.action.reason,
      steps: d.action.steps,
    },
    commentary: d.commentary,
    currentGoalUpdate: d.current_goal_update,
    threatLevel: d.threat_level as ThreatLevel,
  });
}

function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  if (trimmed.startsWith('{')) {
    return trimmed;
  }

  return null;
}
