import type { OrchestratorState, OperationMode } from '../types/state.js';
import type { OrchestratorEvent } from '../types/events.js';

type TransitionCallback = (
  from: OrchestratorState,
  to: OrchestratorState,
  event: OrchestratorEvent,
) => void;

type TransitionMap = Partial<
  Record<OrchestratorEvent['type'], OrchestratorState | ((sm: StateMachine) => OrchestratorState)>
>;

/**
 * STOP_TRIGGERED は複数の状態から受け付ける。
 * LIVE_RUNNING → ENDING_STREAM、それ以外 → IDLE。
 */
function handleStop(currentState: OrchestratorState): OrchestratorState | null {
  switch (currentState) {
    case 'LIVE_RUNNING':
      return 'ENDING_STREAM';
    case 'BOOTING':
    case 'PREPARING_STREAM':
    case 'COOL_DOWN':
    case 'CREATING_NEXT_STREAM':
      return 'IDLE';
    default:
      return null;
  }
}

const TRANSITIONS: Record<OrchestratorState, TransitionMap> = {
  IDLE: {
    START_TRIGGERED: 'BOOTING',
  },
  BOOTING: {
    BOOT_COMPLETE: 'PREPARING_STREAM',
  },
  PREPARING_STREAM: {
    STREAM_READY: 'LIVE_RUNNING',
  },
  LIVE_RUNNING: {
    DEATH_DETECTED: 'DEATH_DETECTED',
  },
  DEATH_DETECTED: {
    STREAM_ENDED: 'ENDING_STREAM',
  },
  ENDING_STREAM: {
    COOLDOWN_EXPIRED: (sm) => (sm.getMode() === 'AUTO' ? 'COOL_DOWN' : 'IDLE'),
  },
  COOL_DOWN: {
    NEXT_STREAM_CREATED: 'CREATING_NEXT_STREAM',
    DAILY_LIMIT_REACHED: 'SUSPENDED_UNTIL_NEXT_DAY',
  },
  CREATING_NEXT_STREAM: {
    START_TRIGGERED: 'BOOTING',
  },
  RECOVERING: {
    RECOVERY_SUCCESS: 'LIVE_RUNNING',
    RECOVERY_FAILED: 'IDLE',
  },
  RETRY_WAIT: {
    START_TRIGGERED: 'BOOTING',
  },
  SUSPENDED_UNTIL_NEXT_DAY: {
    START_TRIGGERED: 'BOOTING',
  },
};

/**
 * オーケストレーターの状態機械。
 * 仕様書のセクション 8 の状態遷移を実装。
 * 有効な遷移のみ受け付け、無効なイベントは無視して null を返す。
 */
export class StateMachine {
  private state: OrchestratorState;
  private mode: OperationMode;
  private callbacks: TransitionCallback[] = [];

  constructor(initialState: OrchestratorState, mode: OperationMode) {
    this.state = initialState;
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

  onTransition(callback: TransitionCallback): void {
    this.callbacks.push(callback);
  }

  transition(event: OrchestratorEvent): OrchestratorState | null {
    // STOP_TRIGGERED は特殊: 複数状態から受け付ける
    if (event.type === 'STOP_TRIGGERED') {
      const next = handleStop(this.state);
      if (next !== null) {
        const from = this.state;
        this.state = next;
        this.notifyCallbacks(from, next, event);
      }
      return next;
    }

    const stateTransitions = TRANSITIONS[this.state];
    const target = stateTransitions[event.type];

    if (target === undefined) return null;

    const nextState = typeof target === 'function' ? target(this) : target;
    const from = this.state;
    this.state = nextState;
    this.notifyCallbacks(from, nextState, event);
    return nextState;
  }

  private notifyCallbacks(
    from: OrchestratorState,
    to: OrchestratorState,
    event: OrchestratorEvent,
  ): void {
    for (const cb of this.callbacks) {
      cb(from, to, event);
    }
  }
}
