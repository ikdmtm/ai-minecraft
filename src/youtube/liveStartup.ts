import type { YouTubeClient } from './api.js';

export interface YoutubeLiveStartupOptions {
  timeoutMs: number;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_RETRY_DELAY_MS = 3_000;

export async function waitForYoutubeIngestActive(
  client: Pick<YouTubeClient, 'getStreamStatus'>,
  streamId: string,
  options: YoutubeLiveStartupOptions,
): Promise<void> {
  const started = Date.now();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  let sawReady = false;

  while (Date.now() - started < options.timeoutMs) {
    const res = await client.getStreamStatus(streamId);
    if (res.ok) {
      if (res.value === 'active') {
        options.log?.('[YouTube] インジェスト active を確認しました');
        return;
      }
      if (res.value === 'ready' && !sawReady) {
        sawReady = true;
        options.log?.('[YouTube] インジェスト接続済み。active になるまで待機します (ready)');
      }
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`YouTube ingest did not become active within ${options.timeoutMs}ms`);
}

export async function goLiveWhenIngestActive(
  client: Pick<YouTubeClient, 'getStreamStatus' | 'getBroadcastStatus' | 'goLive' | 'transitionToTesting'>,
  broadcastId: string,
  streamId: string,
  options: YoutubeLiveStartupOptions,
): Promise<void> {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    await waitForYoutubeIngestActive(client, streamId, {
      ...options,
      timeoutMs: Math.max(1, deadline - Date.now()),
      sleep,
    });

    await ensureBroadcastTesting(client, broadcastId, {
      ...options,
      timeoutMs: Math.max(1, deadline - Date.now()),
      sleep,
    });

    const go = await client.goLive(broadcastId);
    if (go.ok) {
      options.log?.('[YouTube] 配信を Live 状態にしました');
      return;
    }

    if (!go.error.includes('Stream is inactive')) {
      throw new Error(go.error);
    }

    options.log?.('[YouTube] goLive が早すぎたため再試行します (Stream is inactive)');
    await sleep(retryDelayMs);
  }

  throw new Error(`YouTube goLive did not succeed within ${options.timeoutMs}ms`);
}

async function ensureBroadcastTesting(
  client: Pick<YouTubeClient, 'getBroadcastStatus' | 'transitionToTesting'>,
  broadcastId: string,
  options: YoutubeLiveStartupOptions,
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + options.timeoutMs;

  const initial = await client.getBroadcastStatus(broadcastId);
  if (!initial.ok) {
    throw new Error(initial.error);
  }

  if (initial.value === 'testing' || initial.value === 'live' || initial.value === 'liveStarting') {
    return;
  }

  if (initial.value === 'ready' || initial.value === 'created') {
    options.log?.('[YouTube] 配信枠を testing に遷移します');
    const testing = await client.transitionToTesting(broadcastId);
    if (!testing.ok && !testing.error.includes('redundantTransition')) {
      throw new Error(testing.error);
    }
  }

  while (Date.now() < deadline) {
    const status = await client.getBroadcastStatus(broadcastId);
    if (status.ok) {
      if (status.value === 'testing' || status.value === 'live' || status.value === 'liveStarting') {
        options.log?.('[YouTube] 配信枠 testing を確認しました');
        return;
      }
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(`YouTube broadcast did not reach testing within ${options.timeoutMs}ms`);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

