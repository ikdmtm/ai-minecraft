import { waitForProcessStability, type StableProcess } from '../stream/processHealth.js';

export interface LiveStreamProcess extends StableProcess {
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface LiveStreamTarget {
  rtmpUrl: string;
  goLive?: () => Promise<void>;
  finalize?: () => Promise<void>;
}

export interface LiveStreamSessionDeps {
  avatarRenderer: {
    start(): void;
    stop(): void;
  };
  avatarWriter: {
    createPipe(): void;
    connectPipe(): void;
    stop(): void;
  };
  hudWriter: {
    start(): void;
    stop(): void;
  };
  audioPlayer: {
    stop(): void;
  };
  startFfmpeg: (rtmpUrl: string) => LiveStreamProcess;
  waitForProcessStability?: (process: StableProcess, stableMs: number) => Promise<void>;
  waitForConnectPipeDelay?: (delayMs: number) => Promise<void>;
  connectPipeDelayMs?: number;
  stableMs?: number;
  onUnexpectedExit?: (code: number | null) => void;
}

const DEFAULT_CONNECT_PIPE_DELAY_MS = 1_000;
const DEFAULT_STABLE_MS = 3_000;

export class LiveStreamSession {
  private process: LiveStreamProcess | null = null;
  private target: LiveStreamTarget | null = null;
  private live = false;
  private stopping = false;
  private readonly waitForStability: (process: StableProcess, stableMs: number) => Promise<void>;
  private readonly waitForConnectPipeDelay: (delayMs: number) => Promise<void>;

  constructor(private readonly deps: LiveStreamSessionDeps) {
    this.waitForStability = deps.waitForProcessStability ?? waitForProcessStability;
    this.waitForConnectPipeDelay = deps.waitForConnectPipeDelay ?? sleep;
  }

  isLive(): boolean {
    return this.live;
  }

  async start(target: LiveStreamTarget): Promise<void> {
    if (this.process) {
      throw new Error('live stream session is already active');
    }

    this.target = target;
    this.deps.avatarRenderer.start();
    this.deps.avatarWriter.createPipe();
    this.deps.hudWriter.start();

    try {
      const process = this.deps.startFfmpeg(target.rtmpUrl);
      this.process = process;
      process.once('exit', (code) => {
        this.process = null;
        const shouldNotify = this.live && !this.stopping;
        this.live = false;
        if (shouldNotify) {
          this.deps.onUnexpectedExit?.(code);
        }
      });

      await this.waitForConnectPipeDelay(this.deps.connectPipeDelayMs ?? DEFAULT_CONNECT_PIPE_DELAY_MS);
      this.deps.avatarWriter.connectPipe();
      await this.waitForStability(process, this.deps.stableMs ?? DEFAULT_STABLE_MS);
      await target.goLive?.();
      this.live = true;
    } catch (error) {
      try {
        await this.stop();
      } catch {
        // Prefer the startup error when rollback also fails.
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.stopping = true;
    const target = this.target;
    this.target = null;

    try {
      this.live = false;
      this.deps.audioPlayer.stop();
      this.deps.avatarRenderer.stop();
      this.deps.avatarWriter.stop();
      this.deps.hudWriter.stop();

      const process = this.process;
      this.process = null;
      process?.kill('SIGTERM');

      await target?.finalize?.();
    } finally {
      this.stopping = false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
