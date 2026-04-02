import {
  FFmpegManager,
  buildFFmpegArgs,
  buildHudFilters,
  type FFmpegConfig,
  type HudOverlayConfig,
  type ProcessSpawner,
  type FFmpegProcess,
} from './ffmpeg';

const BASE_CONFIG: FFmpegConfig = {
  display: ':99',
  resolution: '1920x1080',
  fps: 30,
  videoBitrate: '4500k',
  audioBitrate: '128k',
  rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2/test-key',
  pulseAudioSource: 'combined_sink.monitor',
  avatarBasePath: 'assets/avatar',
  avatarPipePath: '/tmp/ai-minecraft-avatar.pipe',
  avatarWidth: 300,
  avatarHeight: 400,
  avatarFps: 5,
};

const HUD_CONFIG: HudOverlayConfig = {
  enabled: true,
  fontPath: '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  filePaths: {
    stats: '/tmp/hud/ai-mc-hud-stats.txt',
    info: '/tmp/hud/ai-mc-hud-info.txt',
    goal: '/tmp/hud/ai-mc-hud-goal.txt',
    commentary: '/tmp/hud/ai-mc-hud-commentary.txt',
  },
};

describe('buildFFmpegArgs', () => {
  it('includes x11grab input', () => {
    const args = buildFFmpegArgs(BASE_CONFIG);
    expect(args).toContain('-f');
    expect(args).toContain('x11grab');
    expect(args).toContain('-i');
    expect(args).toContain(':99');
  });

  it('includes pulse audio input', () => {
    const args = buildFFmpegArgs(BASE_CONFIG);
    const pulseIdx = args.indexOf('pulse');
    expect(pulseIdx).toBeGreaterThan(0);
    expect(args[pulseIdx - 1]).toBe('-f');
    expect(args).toContain('-i');
    expect(args).toContain('combined_sink.monitor');
  });

  it('adds thread queues to each real-time input', () => {
    const args = buildFFmpegArgs(BASE_CONFIG);
    const queueCount = args.filter((arg) => arg === '-thread_queue_size').length;
    expect(queueCount).toBe(3);
    expect(args).toContain('2048');
  });

  it('includes resolution and framerate', () => {
    const args = buildFFmpegArgs(BASE_CONFIG);
    expect(args).toContain('1920x1080');
    expect(args).toContain('30');
  });

  it('includes RTMP output', () => {
    const args = buildFFmpegArgs(BASE_CONFIG);
    expect(args[args.length - 1]).toBe('rtmp://a.rtmp.youtube.com/live2/test-key');
  });

  it('includes video codec settings', () => {
    const args = buildFFmpegArgs(BASE_CONFIG);
    expect(args).toContain('-c:v');
    expect(args).toContain('libx264');
    expect(args).toContain('ultrafast');
    expect(args).toContain('zerolatency');
  });

  it('includes output frame rate cap', () => {
    const args = buildFFmpegArgs(BASE_CONFIG);
    const rIdx = args.indexOf('-r');
    expect(rIdx).toBeGreaterThan(0);
    expect(args[rIdx + 1]).toBe('30');
  });

  it('includes audio codec settings', () => {
    const args = buildFFmpegArgs(BASE_CONFIG);
    expect(args).toContain('-c:a');
    expect(args).toContain('aac');
  });

  it('uses yuv420p output for YouTube compatibility', () => {
    const args = buildFFmpegArgs(BASE_CONFIG);
    const pixFmtIdx = args.indexOf('-pix_fmt');
    expect(pixFmtIdx).toBeGreaterThan(0);
    expect(args[pixFmtIdx + 1]).toBe('yuv420p');
  });

  it('uses CBR-oriented output settings for YouTube ingest stability', () => {
    const args = buildFFmpegArgs(BASE_CONFIG);
    const minRateIdx = args.indexOf('-minrate');
    const maxRateIdx = args.indexOf('-maxrate');
    const paramsIdx = args.indexOf('-x264-params');

    expect(minRateIdx).toBeGreaterThan(0);
    expect(args[minRateIdx + 1]).toBe(BASE_CONFIG.videoBitrate);
    expect(maxRateIdx).toBeGreaterThan(0);
    expect(args[maxRateIdx + 1]).toBe(BASE_CONFIG.videoBitrate);
    expect(paramsIdx).toBeGreaterThan(0);
    expect(args[paramsIdx + 1]).toContain('nal-hrd=cbr');
    expect(args[paramsIdx + 1]).toContain('force-cfr=1');
  });

  it('includes avatar overlay filter', () => {
    const args = buildFFmpegArgs(BASE_CONFIG);
    const filterIdx = args.indexOf('-filter_complex');
    expect(filterIdx).toBeGreaterThan(0);
    const filterStr = args[filterIdx + 1];
    expect(filterStr).toContain('overlay');
  });

  it('includes rawvideo avatar input from named pipe', () => {
    const args = buildFFmpegArgs(BASE_CONFIG);
    const rawIdx = args.indexOf('rawvideo');
    expect(rawIdx).toBeGreaterThan(0);
    expect(args[rawIdx - 1]).toBe('-f');
    expect(args).toContain('rgba');
    expect(args).toContain('300x400');
    expect(args).toContain('/tmp/ai-minecraft-avatar.pipe');
  });

  it('includes drawtext filters when HUD is enabled', () => {
    const args = buildFFmpegArgs({ ...BASE_CONFIG, hud: HUD_CONFIG });
    const filterIdx = args.indexOf('-filter_complex');
    const filterStr = args[filterIdx + 1];
    expect(filterStr).toContain('drawtext=');
    expect(filterStr).toContain('reload=1');
    expect(filterStr).toContain('ai-mc-hud-stats.txt');
    expect(filterStr).toContain('ai-mc-hud-commentary.txt');
  });

  it('does not include drawtext when HUD is disabled', () => {
    const args = buildFFmpegArgs({
      ...BASE_CONFIG,
      hud: { ...HUD_CONFIG, enabled: false },
    });
    const filterIdx = args.indexOf('-filter_complex');
    const filterStr = args[filterIdx + 1];
    expect(filterStr).not.toContain('drawtext');
  });

  it('does not include drawtext when hud is undefined', () => {
    const args = buildFFmpegArgs(BASE_CONFIG);
    const filterIdx = args.indexOf('-filter_complex');
    const filterStr = args[filterIdx + 1];
    expect(filterStr).not.toContain('drawtext');
  });
});

describe('buildHudFilters', () => {
  it('generates three drawtext filters by default', () => {
    const result = buildHudFilters(HUD_CONFIG);
    const count = (result.match(/drawtext=/g) || []).length;
    expect(count).toBe(3);
  });

  it('includes font path', () => {
    const result = buildHudFilters(HUD_CONFIG);
    expect(result).toContain('NotoSansCJK-Regular.ttc');
  });

  it('includes core hud file paths', () => {
    const result = buildHudFilters(HUD_CONFIG);
    expect(result).toContain('ai-mc-hud-stats.txt');
    expect(result).toContain('ai-mc-hud-goal.txt');
    expect(result).toContain('ai-mc-hud-commentary.txt');
  });

  it('does not include top-right info text by default', () => {
    const result = buildHudFilters(HUD_CONFIG);
    expect(result).not.toContain('ai-mc-hud-info.txt');
  });

  it('includes top-right info text when explicitly enabled', () => {
    const result = buildHudFilters({ ...HUD_CONFIG, showTopRightInfo: true });
    expect(result).toContain('ai-mc-hud-info.txt');
  });

  it('uses reload=1 for dynamic updates', () => {
    const result = buildHudFilters(HUD_CONFIG);
    const reloadCount = (result.match(/reload=1/g) || []).length;
    expect(reloadCount).toBe(3);
  });

  it('positions stats at bottom-left', () => {
    const result = buildHudFilters(HUD_CONFIG);
    expect(result).toContain('x=10:y=H-40');
  });

  it('positions commentary centered at bottom', () => {
    const result = buildHudFilters(HUD_CONFIG);
    expect(result).toContain('x=(W-text_w)/2:y=H-80');
  });
});

describe('FFmpegManager', () => {
  let spawner: jest.Mocked<ProcessSpawner>;
  let mockProcess: jest.Mocked<FFmpegProcess>;
  let manager: FFmpegManager;

  beforeEach(() => {
    mockProcess = {
      pid: 12345,
      kill: jest.fn().mockReturnValue(true),
      on: jest.fn(),
      stderr: { on: jest.fn() },
    } as unknown as jest.Mocked<FFmpegProcess>;

    spawner = { spawn: jest.fn().mockReturnValue(mockProcess) };
    manager = new FFmpegManager(BASE_CONFIG, spawner);
  });

  it('is not running initially', () => {
    expect(manager.isRunning()).toBe(false);
  });

  it('starts FFmpeg process', () => {
    manager.start();
    expect(spawner.spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawner.spawn.mock.calls[0];
    expect(cmd).toBe('ffmpeg');
    expect(args.length).toBeGreaterThan(0);
    expect(manager.isRunning()).toBe(true);
  });

  it('does not start twice', () => {
    manager.start();
    manager.start();
    expect(spawner.spawn).toHaveBeenCalledTimes(1);
  });

  it('stops running process', () => {
    manager.start();
    manager.stop();
    expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    expect(manager.isRunning()).toBe(false);
  });

  it('stop is no-op when not running', () => {
    manager.stop();
    expect(mockProcess.kill).not.toHaveBeenCalled();
  });

  it('getPid returns process pid', () => {
    manager.start();
    expect(manager.getPid()).toBe(12345);
  });

  it('getPid returns null when not running', () => {
    expect(manager.getPid()).toBeNull();
  });

  it('marks as not running on process exit', () => {
    manager.start();
    const onCall = mockProcess.on.mock.calls.find((c) => c[0] === 'exit');
    expect(onCall).toBeDefined();
    const exitHandler = onCall![1] as (code: number | null) => void;
    exitHandler(0);
    expect(manager.isRunning()).toBe(false);
  });

  it('calls onExit callback when process exits', () => {
    const onExit = jest.fn();
    manager = new FFmpegManager(BASE_CONFIG, spawner, { onExit });
    manager.start();
    const onCall = mockProcess.on.mock.calls.find((c) => c[0] === 'exit');
    const exitHandler = onCall![1] as (code: number | null) => void;
    exitHandler(1);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('updateOverlayText stores text for filter update', () => {
    manager.start();
    manager.updateOverlayText('鉄装備を完成させる');
    expect(manager.getCurrentOverlay()).toBe('鉄装備を完成させる');
  });

  it('updateAvatarImage stores current avatar path', () => {
    manager.start();
    manager.updateAvatarImage('assets/avatar/happy_open.png');
    expect(manager.getCurrentAvatar()).toBe('assets/avatar/happy_open.png');
  });
});
