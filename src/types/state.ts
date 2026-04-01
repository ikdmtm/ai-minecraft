export type RuntimeState =
  | 'IDLE'
  | 'STARTING'
  | 'LIVE_RUNNING'
  | 'DEATH_DETECTED'
  | 'RESETTING';

export type OperationMode = 'MANUAL' | 'AUTO';

export interface PersistentState {
  currentState: RuntimeState;
  currentGeneration: number;
  bestRecordMinutes: number;
  currentStreamId: string | null;
  currentStreamKey: string | null;
  survivalStartTime: string | null;
  operationMode: OperationMode;
  dailyStreamCount: number;
  lastStateUpdate: string;
}
