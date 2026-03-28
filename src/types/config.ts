import type { OperationMode } from './state.js';

export interface AppConfig {
  operationMode: OperationMode;
  cooldownMinutes: number;
  maxDailyStreams: number;
  llmProvider: 'anthropic' | 'openai';
  llmModel: string;
  voicevoxSpeakerId: number;
  minecraftRenderDistance: number;
  streamTitleTemplate: string;
  streamDescriptionTemplate: string;
}
