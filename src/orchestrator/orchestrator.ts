import type { OrchestratorState, OperationMode } from '../types/state.js';
import type { Result } from '../types/result.js';

export interface StreamInfo {
  broadcastId: string;
  streamId: string;
  streamKey: string;
  rtmpUrl: string;
}

export interface DeathResult {
  generation: number;
  survivalMinutes: number;
  cause: string;
  lesson: string;
  isNewRecord: boolean;
}

export interface OrchestratorDeps {
  bootServices: () => Promise<Result<void>>;
  prepareStream: () => Promise<Result<StreamInfo>>;
  runOneCycle: () => Promise<Result<unknown>>;
  handleDeath: (cause: string) => Promise<Result<DeathResult>>;
  endStream: () => Promise<Result<void>>;
  isPlayerDead: () => boolean;
  saveState: (partial: Record<string, unknown>) => void;
  getConfig: () => { cooldownMinutes: number; maxDailyStreams: number };
  getDailyStreamCount: () => number;
  incrementDailyStreamCount: () => void;
  startCycleTimer: () => void;
  stopCycleTimer: () => void;
  log: (message: string) => void;
}

/**
 * 全モジュールを繋ぐメインオーケストレーター。
 * MANUAL / AUTO モード対応。状態遷移を駆動し、
 * 各フェーズで適切な依存を呼び出す。
 */
export class Orchestrator {
  private state: OrchestratorState = 'IDLE';
  private mode: OperationMode;
  private streamInfo: StreamInfo | null = null;

  constructor(
    private deps: OrchestratorDeps,
    mode: OperationMode,
  ) {
    this.mode = mode;
  }

  getState(): OrchestratorState {
    return this.state;
  }

  getMode(): OperationMode {
    return this.mode;
  }

  setMode(mode: OperationMode): void {
    this.mode = mode;
  }

  /**
   * 配信開始: IDLE → BOOTING → PREPARING_STREAM → LIVE_RUNNING
   */
  async start(): Promise<void> {
    if (this.state !== 'IDLE' && this.state !== 'CREATING_NEXT_STREAM') return;

    this.setState('BOOTING');
    const bootResult = await this.deps.bootServices();
    if (!bootResult.ok) {
      this.deps.log(`起動失敗: ${bootResult.error}`);
      this.setState('IDLE');
      return;
    }

    this.setState('PREPARING_STREAM');
    const streamResult = await this.deps.prepareStream();
    if (!streamResult.ok) {
      this.deps.log(`配信準備失敗: ${streamResult.error}`);
      this.setState('IDLE');
      return;
    }

    this.streamInfo = streamResult.value;
    this.deps.incrementDailyStreamCount();
    this.setState('LIVE_RUNNING');
    this.deps.startCycleTimer();
  }

  /**
   * 死亡処理: LIVE_RUNNING → DEATH_DETECTED → ENDING_STREAM → (IDLE or COOL_DOWN → 再起動)
   */
  async onDeath(cause: string): Promise<void> {
    if (this.state !== 'LIVE_RUNNING') return;

    this.deps.stopCycleTimer();
    this.setState('DEATH_DETECTED');

    await this.deps.handleDeath(cause);

    this.setState('ENDING_STREAM');
    await this.deps.endStream();

    if (this.mode === 'AUTO') {
      await this.autoRestart();
    } else {
      this.setState('IDLE');
    }
  }

  /**
   * 手動停止
   */
  async stop(): Promise<void> {
    if (this.state === 'IDLE') return;

    this.deps.stopCycleTimer();

    if (this.state === 'LIVE_RUNNING' || this.state === 'DEATH_DETECTED') {
      this.setState('ENDING_STREAM');
      await this.deps.endStream();
    }

    this.setState('IDLE');
  }

  private async autoRestart(): Promise<void> {
    const config = this.deps.getConfig();
    const count = this.deps.getDailyStreamCount();

    if (count >= config.maxDailyStreams) {
      this.deps.log(`日次上限到達 (${count}/${config.maxDailyStreams})`);
      this.setState('SUSPENDED_UNTIL_NEXT_DAY');
      return;
    }

    this.setState('COOL_DOWN');

    if (config.cooldownMinutes > 0) {
      await sleep(config.cooldownMinutes * 60_000);
    }

    this.setState('CREATING_NEXT_STREAM');
    await this.start();
  }

  private setState(state: OrchestratorState): void {
    this.deps.log(`状態遷移: ${this.state} → ${state}`);
    this.state = state;
    this.deps.saveState({ currentState: state, lastStateUpdate: new Date().toISOString() });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
