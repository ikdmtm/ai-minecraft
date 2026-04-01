import { AudioQueue, type AudioPlayer } from './audioQueue';

function createMockPlayer(playDurationMs = 10): AudioPlayer {
  return {
    play: jest.fn().mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, playDurationMs)),
    ),
    stop: jest.fn(),
  };
}

describe('AudioQueue', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('plays a single audio buffer', async () => {
    const player = createMockPlayer();
    const queue = new AudioQueue(player);
    const buf = Buffer.from('audio1');

    queue.enqueue(buf);
    await waitForQueueDrain(queue);

    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.play).toHaveBeenCalledWith(buf);
  });

  it('plays multiple buffers in order', async () => {
    const playOrder: number[] = [];
    const player: AudioPlayer = {
      play: jest.fn().mockImplementation(async (buf: Buffer) => {
        playOrder.push(buf[0]);
        await new Promise((r) => setTimeout(r, 10));
      }),
      stop: jest.fn(),
    };
    const queue = new AudioQueue(player);

    queue.enqueue(Buffer.from([1]));
    queue.enqueue(Buffer.from([2]));
    queue.enqueue(Buffer.from([3]));
    await waitForQueueDrain(queue);

    expect(playOrder).toEqual([1, 2, 3]);
  });

  it('reports isPlaying correctly', async () => {
    const player = createMockPlayer(50);
    const queue = new AudioQueue(player);

    expect(queue.isPlaying()).toBe(false);
    queue.enqueue(Buffer.from('audio'));
    // Give the queue a tick to start processing
    await new Promise((r) => setTimeout(r, 5));
    expect(queue.isPlaying()).toBe(true);
    await waitForQueueDrain(queue);
    expect(queue.isPlaying()).toBe(false);
  });

  it('fires onPlaybackStart callback', async () => {
    const player = createMockPlayer();
    const queue = new AudioQueue(player);
    const startCb = jest.fn();
    queue.onPlaybackStart(startCb);

    queue.enqueue(Buffer.from('audio'));
    await waitForQueueDrain(queue);

    expect(startCb).toHaveBeenCalledTimes(1);
  });

  it('passes the queued text to playback start callback', async () => {
    const player = createMockPlayer();
    const queue = new AudioQueue(player);
    const startCb = jest.fn();
    queue.onPlaybackStart(startCb);

    queue.enqueue(Buffer.from('audio'), '字幕テキスト');
    await waitForQueueDrain(queue);

    expect(startCb).toHaveBeenCalledWith(expect.objectContaining({ text: '字幕テキスト' }));
  });

  it('delays playback start callback to align subtitle timing with audible output', async () => {
    jest.useFakeTimers();
    const player = createMockPlayer(300);
    const queue = new AudioQueue(player, { playbackStartDelayMs: 180, latencyCompensationMs: 0 });
    const startCb = jest.fn();
    queue.onPlaybackStart(startCb);

    queue.enqueue(Buffer.from('audio'));
    await Promise.resolve();

    expect(startCb).not.toHaveBeenCalled();
    jest.advanceTimersByTime(179);
    await Promise.resolve();
    expect(startCb).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await Promise.resolve();
    expect(startCb).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(400);
    await Promise.resolve();
  });

  it('fires onPlaybackEnd callback', async () => {
    const player = createMockPlayer();
    const queue = new AudioQueue(player);
    const endCb = jest.fn();
    queue.onPlaybackEnd(endCb);

    queue.enqueue(Buffer.from('audio'));
    await waitForQueueDrain(queue);

    expect(endCb).toHaveBeenCalledTimes(1);
  });

  it('clear removes pending items', async () => {
    const player = createMockPlayer(50);
    const queue = new AudioQueue(player);

    queue.enqueue(Buffer.from('a'));
    queue.enqueue(Buffer.from('b'));
    queue.enqueue(Buffer.from('c'));
    queue.clear();

    await waitForQueueDrain(queue);
    // Only the first (already playing) should have been played
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it('handles player error gracefully', async () => {
    const player: AudioPlayer = {
      play: jest.fn().mockRejectedValue(new Error('playback failed')),
      stop: jest.fn(),
    };
    const queue = new AudioQueue(player);

    queue.enqueue(Buffer.from('audio'));
    await waitForQueueDrain(queue);

    // Should not throw, and queue should recover
    expect(queue.isPlaying()).toBe(false);
    queue.enqueue(Buffer.from('audio2'));
    await waitForQueueDrain(queue);
    expect(player.play).toHaveBeenCalledTimes(2);
  });

  it('returns correct pending count', () => {
    const player = createMockPlayer(100);
    const queue = new AudioQueue(player);

    expect(queue.pendingCount()).toBe(0);
    queue.enqueue(Buffer.from('a'));
    queue.enqueue(Buffer.from('b'));
    // One is being played, one is pending (timing dependent, so check >= 1)
    expect(queue.pendingCount()).toBeGreaterThanOrEqual(1);
  });

  it('replaces stale pending commentary with the latest one', async () => {
    const playOrder: string[] = [];
    const player: AudioPlayer = {
      play: jest.fn().mockImplementation(async (buf: Buffer) => {
        playOrder.push(buf.toString());
        await new Promise((r) => setTimeout(r, 20));
      }),
      stop: jest.fn(),
    };
    const queue = new AudioQueue(player);

    queue.enqueue(Buffer.from('first'));
    queue.enqueue(Buffer.from('stale'));
    queue.replacePending(Buffer.from('latest'), '最新字幕');
    await waitForQueueDrain(queue);

    expect(playOrder).toEqual(['first', 'latest']);
  });

  it('waits for the WAV duration before ending playback when player resolves too early', async () => {
    jest.useFakeTimers();
    const player: AudioPlayer = {
      play: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn(),
    };
    const queue = new AudioQueue(player, { latencyCompensationMs: 0 });
    const endCb = jest.fn();
    queue.onPlaybackEnd(endCb);

    queue.enqueue(createPcmWavBuffer(120));
    await Promise.resolve();
    expect(endCb).not.toHaveBeenCalled();

    jest.advanceTimersByTime(100);
    await Promise.resolve();
    expect(endCb).not.toHaveBeenCalled();

    jest.advanceTimersByTime(20);
    await Promise.resolve();
    expect(endCb).toHaveBeenCalledTimes(1);
  });
});

async function waitForQueueDrain(queue: AudioQueue, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (queue.isPlaying() || queue.pendingCount() > 0) {
    if (Date.now() - start > timeoutMs) throw new Error('Queue drain timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
  // Extra tick to let callbacks fire
  await new Promise((r) => setTimeout(r, 10));
}

function createPcmWavBuffer(durationMs: number, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}
