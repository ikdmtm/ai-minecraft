import { EventEmitter } from 'events';
import { LiveStreamSession, type LiveStreamProcess, type LiveStreamSessionDeps, type LiveStreamTarget } from './liveStreamSession';

class MockLiveStreamProcess extends EventEmitter implements LiveStreamProcess {
  exitCode: number | null = null;
  kill = jest.fn().mockReturnValue(true);
}

function createDeps(overrides: Partial<LiveStreamSessionDeps> = {}) {
  const process = new MockLiveStreamProcess();
  const deps: LiveStreamSessionDeps = {
    avatarRenderer: {
      start: jest.fn(),
      stop: jest.fn(),
    },
    avatarWriter: {
      createPipe: jest.fn(),
      connectPipe: jest.fn(),
      stop: jest.fn(),
    },
    hudWriter: {
      start: jest.fn(),
      stop: jest.fn(),
    },
    audioPlayer: {
      stop: jest.fn(),
    },
    startFfmpeg: jest.fn().mockReturnValue(process),
    waitForProcessStability: jest.fn().mockResolvedValue(undefined),
    waitForConnectPipeDelay: jest.fn().mockResolvedValue(undefined),
    connectPipeDelayMs: 0,
    stableMs: 25,
    onUnexpectedExit: jest.fn(),
    ...overrides,
  };

  return { deps, process };
}

function createTarget(overrides: Partial<LiveStreamTarget> = {}): LiveStreamTarget {
  return {
    rtmpUrl: 'rtmp://example/live',
    goLive: jest.fn().mockResolvedValue(undefined),
    finalize: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('LiveStreamSession', () => {
  it('starts the new streaming pipeline and stops it cleanly', async () => {
    const { deps, process } = createDeps();
    const target = createTarget();
    const session = new LiveStreamSession(deps);

    await session.start(target);

    expect(deps.avatarRenderer.start).toHaveBeenCalledTimes(1);
    expect(deps.avatarWriter.createPipe).toHaveBeenCalledTimes(1);
    expect(deps.hudWriter.start).toHaveBeenCalledTimes(1);
    expect(deps.startFfmpeg).toHaveBeenCalledWith(target.rtmpUrl);
    expect(deps.avatarWriter.connectPipe).toHaveBeenCalledTimes(1);
    expect(deps.waitForProcessStability).toHaveBeenCalledWith(process, 25);
    expect(target.goLive).toHaveBeenCalledTimes(1);
    expect(session.isLive()).toBe(true);

    await session.stop();

    expect(deps.audioPlayer.stop).toHaveBeenCalledTimes(1);
    expect(deps.avatarRenderer.stop).toHaveBeenCalledTimes(1);
    expect(deps.avatarWriter.stop).toHaveBeenCalledTimes(1);
    expect(deps.hudWriter.stop).toHaveBeenCalledTimes(1);
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    expect(target.finalize).toHaveBeenCalledTimes(1);
    expect(session.isLive()).toBe(false);
  });

  it('rolls back the partially started stream when startup fails', async () => {
    const startupError = new Error('ffmpeg exited before the stream became stable');
    const { deps, process } = createDeps({
      waitForProcessStability: jest.fn().mockRejectedValue(startupError),
    });
    const target = createTarget();
    const session = new LiveStreamSession(deps);

    await expect(session.start(target)).rejects.toThrow(startupError);

    expect(deps.audioPlayer.stop).toHaveBeenCalledTimes(1);
    expect(deps.avatarRenderer.stop).toHaveBeenCalledTimes(1);
    expect(deps.avatarWriter.stop).toHaveBeenCalledTimes(1);
    expect(deps.hudWriter.stop).toHaveBeenCalledTimes(1);
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    expect(target.finalize).toHaveBeenCalledTimes(1);
    expect(session.isLive()).toBe(false);
  });

  it('notifies unexpected ffmpeg exits only after the stream is live', async () => {
    const onUnexpectedExit = jest.fn();
    const { deps, process } = createDeps({ onUnexpectedExit });
    const target = createTarget();
    const session = new LiveStreamSession(deps);

    await session.start(target);
    process.exitCode = 1;
    process.emit('exit', 1, null);

    expect(onUnexpectedExit).toHaveBeenCalledWith(1);
    expect(session.isLive()).toBe(false);
  });

  it('does not report a planned stop as an unexpected ffmpeg exit', async () => {
    const onUnexpectedExit = jest.fn();
    const { deps, process } = createDeps({ onUnexpectedExit });
    const target = createTarget();
    const session = new LiveStreamSession(deps);

    await session.start(target);
    await session.stop();
    process.emit('exit', 0, 'SIGTERM');

    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect(target.finalize).toHaveBeenCalledTimes(1);
  });
});
