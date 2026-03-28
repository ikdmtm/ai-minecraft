export type OrchestratorState =
  | 'IDLE'
  | 'BOOTING'
  | 'PREPARING_STREAM'
  | 'LIVE_RUNNING'
  | 'DEATH_DETECTED'
  | 'ENDING_STREAM'
  | 'COOL_DOWN'
  | 'CREATING_NEXT_STREAM'
  | 'RECOVERING'
  | 'RETRY_WAIT'
  | 'SUSPENDED_UNTIL_NEXT_DAY';

export type OperationMode = 'MANUAL' | 'AUTO';

export interface PersistentState {
  currentState: OrchestratorState;
  currentGeneration: number;
  bestRecordMinutes: number;
  currentStreamId: string | null;
  currentStreamKey: string | null;
  survivalStartTime: string | null;
  operationMode: OperationMode;
  dailyStreamCount: number;
  lastStateUpdate: string;
}
