export type OrchestratorEvent =
  | { type: 'START_TRIGGERED' }
  | { type: 'BOOT_COMPLETE' }
  | { type: 'STREAM_READY' }
  | { type: 'DEATH_DETECTED'; cause: string }
  | { type: 'STREAM_ENDED' }
  | { type: 'COOLDOWN_EXPIRED' }
  | { type: 'NEXT_STREAM_CREATED' }
  | { type: 'RECOVERY_SUCCESS' }
  | { type: 'RECOVERY_FAILED' }
  | { type: 'STOP_TRIGGERED' }
  | { type: 'DAILY_LIMIT_REACHED' };
