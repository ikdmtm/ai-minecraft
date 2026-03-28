import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';

/**
 * HTTP 通信の抽象化。テスト時はモック、本番時は fetch ベースの実装を渡す。
 */
export interface HttpAdapter {
  postJson(url: string, body: object): Promise<unknown>;
  postJsonGetBuffer(url: string, body: object): Promise<Buffer>;
  get(url: string): Promise<{ status: number }>;
}

/**
 * VOICEVOX Engine HTTP API クライアント。
 * audio_query → synthesis の 2 ステップで音声を生成する。
 */
export class VoicevoxClient {
  constructor(
    private host: string,
    private speakerId: number,
    private http: HttpAdapter,
  ) {}

  async synthesize(text: string): Promise<Result<Buffer>> {
    if (!text.trim()) {
      return err('空のテキスト');
    }

    try {
      const encodedText = encodeURIComponent(text);
      const queryUrl = `${this.host}/audio_query?text=${encodedText}&speaker=${this.speakerId}`;
      const audioQuery = await this.http.postJson(queryUrl, {});

      const synthesisUrl = `${this.host}/synthesis?speaker=${this.speakerId}`;
      const wavBuffer = await this.http.postJsonGetBuffer(synthesisUrl, audioQuery as object);

      // WAV ヘッダー (44 bytes) 以下は異常。VOICEVOX が空音声を返す場合のガード
      const MIN_WAV_SIZE = 100;
      if (!wavBuffer || wavBuffer.length < MIN_WAV_SIZE) {
        return err(`異常な音声データ (${wavBuffer?.length ?? 0} bytes)`);
      }

      return ok(wavBuffer);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`VOICEVOX エラー: ${msg}`);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.http.get(`${this.host}/version`);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * fetch ベースの本番用 HttpAdapter。
 */
export function createFetchAdapter(): HttpAdapter {
  return {
    async postJson(url: string, body: object): Promise<unknown> {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return res.json();
    },
    async postJsonGetBuffer(url: string, body: object): Promise<Buffer> {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    },
    async get(url: string): Promise<{ status: number }> {
      const res = await fetch(url);
      return { status: res.status };
    },
  };
}
