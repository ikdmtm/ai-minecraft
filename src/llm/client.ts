import type { GameState } from '../types/gameState.js';
import type { LLMOutput } from '../types/llm.js';
import type { Position, RecentEvent } from '../types/index.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';
import { buildSystemPrompt, buildUserMessage } from './promptBuilder.js';
import { parseResponse } from './responseParser.js';

export interface DeathContext {
  position: Position;
  cause: string;
  recentActions: RecentEvent[];
  survivalMinutes: number;
}

/**
 * LLM API の抽象化。Anthropic / OpenAI 等の実装を差し替え可能にする。
 */
export interface LLMApiAdapter {
  call(systemPrompt: string, userMessage: string): Promise<string>;
}

/**
 * LLM クライアント。プロンプト構築 → API 呼び出し → レスポンスパースを一貫して行う。
 */
export class LLMClient {
  private consecutiveFailures = 0;
  private adapter: LLMApiAdapter;

  constructor(adapter: LLMApiAdapter) {
    this.adapter = adapter;
  }

  async call(gameState: GameState): Promise<Result<LLMOutput>> {
    const systemPrompt = buildSystemPrompt();
    const userMessage = buildUserMessage(gameState);

    let rawResponse: string;
    try {
      rawResponse = await this.adapter.call(systemPrompt, userMessage);
    } catch (e) {
      this.consecutiveFailures++;
      const msg = e instanceof Error ? e.message : String(e);
      return err(`LLM API エラー: ${msg}`);
    }

    const parsed = parseResponse(rawResponse);
    if (!parsed.ok) {
      this.consecutiveFailures++;
      return err(`LLM レスポンスパースエラー: ${parsed.error}`);
    }

    this.consecutiveFailures = 0;
    return ok(parsed.value);
  }

  async generateDeathLesson(context: DeathContext): Promise<Result<string>> {
    const systemPrompt =
      'あなたは Minecraft ハードコアモードの死亡分析AIです。死亡状況を分析し、1文で教訓を要約してください。教訓のみを返してください。';
    const userMessage = JSON.stringify({
      position: context.position,
      cause: context.cause,
      recent_actions: context.recentActions,
      survival_minutes: context.survivalMinutes,
    });

    try {
      const response = await this.adapter.call(systemPrompt, userMessage);
      const trimmed = response.trim();
      if (!trimmed) return err('空のレスポンス');
      return ok(trimmed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`教訓生成エラー: ${msg}`);
    }
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }
}
