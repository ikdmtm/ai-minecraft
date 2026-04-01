import { err, ok } from '../types/result';
import { goLiveWhenIngestActive, waitForYoutubeIngestActive } from './liveStartup';
import type { BroadcastLifeCycleStatus, StreamStatus, YouTubeClient } from './api';

function createClient(
  streamStatuses: StreamStatus[],
  broadcastStatuses: BroadcastLifeCycleStatus[] = ['ready'],
  goLiveResults: Array<ReturnType<typeof ok<void>> | ReturnType<typeof err>> = [ok(undefined)],
  testingResults: Array<ReturnType<typeof ok<void>> | ReturnType<typeof err>> = [ok(undefined)],
): Pick<YouTubeClient, 'getStreamStatus' | 'getBroadcastStatus' | 'goLive' | 'transitionToTesting'> {
  let statusIndex = 0;
  let broadcastStatusIndex = 0;
  let goLiveIndex = 0;
  let testingIndex = 0;

  return {
    getStreamStatus: jest.fn().mockImplementation(async () => {
      const value = streamStatuses[Math.min(statusIndex, streamStatuses.length - 1)];
      statusIndex++;
      return ok(value);
    }),
    getBroadcastStatus: jest.fn().mockImplementation(async () => {
      const value = broadcastStatuses[Math.min(broadcastStatusIndex, broadcastStatuses.length - 1)];
      broadcastStatusIndex++;
      return ok(value);
    }),
    goLive: jest.fn().mockImplementation(async () => {
      const value = goLiveResults[Math.min(goLiveIndex, goLiveResults.length - 1)];
      goLiveIndex++;
      return value;
    }),
    transitionToTesting: jest.fn().mockImplementation(async () => {
      const value = testingResults[Math.min(testingIndex, testingResults.length - 1)];
      testingIndex++;
      return value;
    }),
  } as Pick<YouTubeClient, 'getStreamStatus' | 'getBroadcastStatus' | 'goLive' | 'transitionToTesting'>;
}

describe('waitForYoutubeIngestActive', () => {
  it('waits until the stream becomes active instead of returning at ready', async () => {
    const client = createClient(['inactive', 'ready', 'ready', 'active']);
    const sleep = jest.fn().mockResolvedValue(undefined);
    const log = jest.fn();

    await waitForYoutubeIngestActive(client, 'stream-1', {
      timeoutMs: 20_000,
      pollIntervalMs: 1_000,
      sleep,
      log,
    });

    expect(client.getStreamStatus).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenCalledWith('[YouTube] インジェスト接続済み。active になるまで待機します (ready)');
    expect(log).toHaveBeenCalledWith('[YouTube] インジェスト active を確認しました');
  });

  it('throws on timeout when the stream never becomes active', async () => {
    const client = createClient(['ready', 'ready', 'ready']);
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(waitForYoutubeIngestActive(client, 'stream-1', {
      timeoutMs: 2_500,
      pollIntervalMs: 1_000,
      sleep,
    })).rejects.toThrow('YouTube ingest did not become active within 2500ms');
  });
});

describe('goLiveWhenIngestActive', () => {
  it('transitions to testing before going live when monitor stream is enabled', async () => {
    const client = createClient(
      ['ready', 'active'],
      ['ready', 'testStarting', 'testing'],
      [ok(undefined)],
      [ok(undefined)],
    );
    const sleep = jest.fn().mockResolvedValue(undefined);
    const log = jest.fn();

    await goLiveWhenIngestActive(client, 'broadcast-1', 'stream-1', {
      timeoutMs: 20_000,
      pollIntervalMs: 1_000,
      retryDelayMs: 500,
      sleep,
      log,
    });

    expect(client.transitionToTesting).toHaveBeenCalledTimes(1);
    expect(client.goLive).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[YouTube] 配信枠を testing に遷移します');
    expect(log).toHaveBeenCalledWith('[YouTube] 配信枠 testing を確認しました');
    expect(log).toHaveBeenCalledWith('[YouTube] 配信を Live 状態にしました');
  });

  it('retries goLive when YouTube still reports the stream as inactive', async () => {
    const client = createClient(
      ['ready', 'active', 'active'],
      ['testing'],
      [err('配信開始失敗: Stream is inactive'), ok(undefined)],
    );
    const sleep = jest.fn().mockResolvedValue(undefined);
    const log = jest.fn();

    await goLiveWhenIngestActive(client, 'broadcast-1', 'stream-1', {
      timeoutMs: 20_000,
      pollIntervalMs: 1_000,
      retryDelayMs: 500,
      sleep,
      log,
    });

    expect(client.goLive).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('[YouTube] goLive が早すぎたため再試行します (Stream is inactive)');
  });

  it('throws when goLive fails for a non-retriable reason', async () => {
    const client = createClient(['active'], ['testing'], [err('配信開始失敗: quota exceeded')]);
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(goLiveWhenIngestActive(client, 'broadcast-1', 'stream-1', {
      timeoutMs: 20_000,
      pollIntervalMs: 1_000,
      retryDelayMs: 500,
      sleep,
    })).rejects.toThrow('配信開始失敗: quota exceeded');
  });
});
