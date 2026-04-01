import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';

export interface BroadcastCreateParams {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus?: 'private' | 'public' | 'unlisted';
}

export interface BroadcastCreateResult {
  broadcastId: string;
  streamId: string;
  streamKey: string;
  rtmpUrl: string;
}

export type StreamStatus = 'active' | 'inactive' | 'ready' | 'error';
export type BroadcastLifeCycleStatus =
  | 'complete'
  | 'created'
  | 'live'
  | 'liveStarting'
  | 'ready'
  | 'revoked'
  | 'testStarting'
  | 'testing';

/**
 * YouTube Data API / Live Streaming API の抽象化。
 * 本番は googleapis パッケージで実装し、テストではモックを注入する。
 */
export interface YouTubeApiAdapter {
  createBroadcast(params: BroadcastCreateParams): Promise<BroadcastCreateResult>;
  transitionBroadcast(broadcastId: string, status: 'live' | 'complete' | 'testing'): Promise<void>;
  updateBroadcast(broadcastId: string, update: { title?: string; description?: string }): Promise<void>;
  endBroadcast(broadcastId: string): Promise<void>;
  uploadThumbnail(broadcastId: string, filePath: string): Promise<void>;
  getStreamStatus(streamId: string): Promise<StreamStatus>;
  getBroadcastStatus(broadcastId: string): Promise<BroadcastLifeCycleStatus>;
}

/**
 * YouTube 配信の操作を提供するクライアント。
 * エラーハンドリングを Result 型で統一し、
 * オーケストレーターから安全に呼び出せるようにする。
 */
export class YouTubeClient {
  constructor(private readonly adapter: YouTubeApiAdapter) {}

  async createLiveBroadcast(params: BroadcastCreateParams): Promise<Result<BroadcastCreateResult>> {
    try {
      const result = await this.adapter.createBroadcast(params);
      return ok(result);
    } catch (e) {
      return err(`配信枠作成失敗: ${errorMessage(e)}`);
    }
  }

  async goLive(broadcastId: string): Promise<Result<void>> {
    try {
      await this.adapter.transitionBroadcast(broadcastId, 'live');
      return ok(undefined);
    } catch (e) {
      return err(`配信開始失敗: ${errorMessage(e)}`);
    }
  }

  async endBroadcast(broadcastId: string): Promise<Result<void>> {
    try {
      await this.adapter.transitionBroadcast(broadcastId, 'complete');
      return ok(undefined);
    } catch (e) {
      if (errorMessage(e).includes('redundantTransition')) {
        return ok(undefined);
      }
      return err(`配信終了失敗: ${errorMessage(e)}`);
    }
  }

  async transitionToTesting(broadcastId: string): Promise<Result<void>> {
    try {
      await this.adapter.transitionBroadcast(broadcastId, 'testing');
      return ok(undefined);
    } catch (e) {
      return err(`testing 遷移失敗: ${errorMessage(e)}`);
    }
  }

  async updateTitle(broadcastId: string, title: string): Promise<Result<void>> {
    try {
      await this.adapter.updateBroadcast(broadcastId, { title });
      return ok(undefined);
    } catch (e) {
      return err(`タイトル更新失敗: ${errorMessage(e)}`);
    }
  }

  async uploadThumbnail(broadcastId: string, filePath: string): Promise<Result<void>> {
    try {
      await this.adapter.uploadThumbnail(broadcastId, filePath);
      return ok(undefined);
    } catch (e) {
      return err(`サムネイルアップロード失敗: ${errorMessage(e)}`);
    }
  }

  async getStreamStatus(streamId: string): Promise<Result<StreamStatus>> {
    try {
      const status = await this.adapter.getStreamStatus(streamId);
      return ok(status);
    } catch (e) {
      return err(`ストリームステータス取得失敗: ${errorMessage(e)}`);
    }
  }

  async getBroadcastStatus(broadcastId: string): Promise<Result<BroadcastLifeCycleStatus>> {
    try {
      const status = await this.adapter.getBroadcastStatus(broadcastId);
      return ok(status);
    } catch (e) {
      return err(`配信枠ステータス取得失敗: ${errorMessage(e)}`);
    }
  }

  async isHealthy(streamId: string): Promise<boolean> {
    try {
      const status = await this.adapter.getStreamStatus(streamId);
      return status === 'active';
    } catch {
      return false;
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
