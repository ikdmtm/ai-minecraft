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

export interface LLMClientOptions {
  maxRetries?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

const DEFAULT_OPTIONS: Required<LLMClientOptions> = {
  maxRetries: 2,
  timeoutMs: 30_000,
  retryDelayMs: 1_000,
};

/**
 * LLM クライアント。プロンプト構築 → API 呼び出し → レスポンスパースを一貫して行う。
 * パース失敗時は即座にリトライ、API エラー時はバックオフ付きリトライ。
 */
export class LLMClient {
  private consecutiveFailures = 0;
  private adapter: LLMApiAdapter;
  private options: Required<LLMClientOptions>;

  constructor(adapter: LLMApiAdapter, options?: LLMClientOptions) {
    this.adapter = adapter;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async call(gameState: GameState): Promise<Result<LLMOutput>> {
    const systemPrompt = buildSystemPrompt();
    const userMessage = buildUserMessage(gameState);

    let lastError = '';

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      // API エラー時はバックオフ（初回は待たない）
      if (attempt > 0 && lastError.startsWith('LLM API')) {
        await sleep(this.options.retryDelayMs * attempt);
      }

      let rawResponse: string;
      try {
        rawResponse = await callWithTimeout(
          () => this.adapter.call(systemPrompt, userMessage),
          this.options.timeoutMs,
        );
      } catch (e) {
        lastError = `LLM API エラー: ${errorMessage(e)}`;
        continue;
      }

      const parsed = parseResponse(rawResponse);
      if (!parsed.ok) {
        lastError = `LLM レスポンスパースエラー: ${parsed.error}`;
        // パース失敗は即座にリトライ（待たない）
        continue;
      }

      this.consecutiveFailures = 0;
      return ok(parsed.value);
    }

    this.consecutiveFailures++;
    return err(`${lastError} (${this.options.maxRetries + 1}回試行後)`);
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
      const response = await callWithTimeout(
        () => this.adapter.call(systemPrompt, userMessage),
        this.options.timeoutMs,
      );
      const trimmed = response.trim();
      if (!trimmed) return err('空のレスポンス');
      return ok(trimmed);
    } catch (e) {
      return err(`教訓生成エラー: ${errorMessage(e)}`);
    }
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`タイムアウト (${timeoutMs}ms)`));
    }, timeoutMs);

    fn().then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
