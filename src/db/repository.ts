import type Database from 'better-sqlite3';
import type { DeathRecord } from '../types/gameState.js';
import type { PersistentState } from '../types/state.js';
import type { AppConfig } from '../types/config.js';

export interface ActionLog {
  timestamp: string;
  type: 'llm_response' | 'reactive_action' | 'state_change' | 'error';
  content: string;
}

const DEFAULT_STATE: PersistentState = {
  currentState: 'IDLE',
  currentGeneration: 0,
  bestRecordMinutes: 0,
  currentStreamId: null,
  currentStreamKey: null,
  survivalStartTime: null,
  operationMode: 'MANUAL',
  dailyStreamCount: 0,
  lastStateUpdate: new Date().toISOString(),
};

const DEFAULT_CONFIG: AppConfig = {
  operationMode: 'MANUAL',
  cooldownMinutes: 10,
  maxDailyStreams: 20,
  llmProvider: 'anthropic',
  llmModel: 'claude-sonnet',
  voicevoxSpeakerId: 3,
  minecraftRenderDistance: 8,
  streamTitleTemplate: '【AI Minecraft】星守レイのハードコア生存実験 #Gen{gen}',
  streamDescriptionTemplate: '',
};

export class Repository {
  private stmtGetState: Database.Statement;
  private stmtSetState: Database.Statement;
  private stmtInsertDeath: Database.Statement;
  private stmtRecentDeaths: Database.Statement;
  private stmtBestRecord: Database.Statement;
  private stmtInsertLog: Database.Statement;
  private stmtRecentLogs: Database.Statement;
  private stmtGetConfig: Database.Statement;
  private stmtSetConfig: Database.Statement;
  private stmtGetAllConfig: Database.Statement;
  private stmtGetAllState: Database.Statement;

  constructor(private db: Database.Database) {
    this.stmtGetState = db.prepare('SELECT value FROM state WHERE key = ?');
    this.stmtSetState = db.prepare(
      'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.stmtGetAllState = db.prepare('SELECT key, value FROM state');

    this.stmtInsertDeath = db.prepare(
      'INSERT INTO death_history (generation, survival_minutes, cause, lesson) VALUES (?, ?, ?, ?)',
    );
    this.stmtRecentDeaths = db.prepare(
      'SELECT generation, survival_minutes, cause, lesson FROM death_history ORDER BY id DESC LIMIT ?',
    );
    this.stmtBestRecord = db.prepare(
      'SELECT MAX(survival_minutes) as best FROM death_history',
    );

    this.stmtInsertLog = db.prepare(
      'INSERT INTO action_log (timestamp, type, content) VALUES (?, ?, ?)',
    );
    this.stmtRecentLogs = db.prepare(
      'SELECT timestamp, type, content FROM action_log ORDER BY id DESC LIMIT ?',
    );

    this.stmtGetConfig = db.prepare('SELECT value FROM config WHERE key = ?');
    this.stmtSetConfig = db.prepare(
      'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.stmtGetAllConfig = db.prepare('SELECT key, value FROM config');
  }

  getState(): PersistentState {
    const rows = this.stmtGetAllState.all() as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return {
      currentState: (map.get('currentState') as PersistentState['currentState']) ?? DEFAULT_STATE.currentState,
      currentGeneration: Number(map.get('currentGeneration') ?? DEFAULT_STATE.currentGeneration),
      bestRecordMinutes: Number(map.get('bestRecordMinutes') ?? DEFAULT_STATE.bestRecordMinutes),
      currentStreamId: map.get('currentStreamId') ?? DEFAULT_STATE.currentStreamId,
      currentStreamKey: map.get('currentStreamKey') ?? DEFAULT_STATE.currentStreamKey,
      survivalStartTime: map.get('survivalStartTime') ?? DEFAULT_STATE.survivalStartTime,
      operationMode: (map.get('operationMode') as PersistentState['operationMode']) ?? DEFAULT_STATE.operationMode,
      dailyStreamCount: Number(map.get('dailyStreamCount') ?? DEFAULT_STATE.dailyStreamCount),
      lastStateUpdate: map.get('lastStateUpdate') ?? DEFAULT_STATE.lastStateUpdate,
    };
  }

  saveState(partial: Partial<PersistentState>): void {
    const save = this.db.transaction(() => {
      for (const [key, value] of Object.entries(partial)) {
        const serialized = value === null ? null : String(value);
        if (serialized === null) {
          this.db.prepare('DELETE FROM state WHERE key = ?').run(key);
        } else {
          this.stmtSetState.run(key, serialized);
        }
      }
    });
    save();
  }

  addDeathRecord(record: DeathRecord): void {
    this.stmtInsertDeath.run(
      record.generation,
      record.survivalMinutes,
      record.cause,
      record.lesson,
    );
  }

  getRecentDeaths(limit: number): DeathRecord[] {
    const rows = this.stmtRecentDeaths.all(limit) as Array<{
      generation: number;
      survival_minutes: number;
      cause: string;
      lesson: string;
    }>;
    return rows.map((r) => ({
      generation: r.generation,
      survivalMinutes: r.survival_minutes,
      cause: r.cause,
      lesson: r.lesson,
    }));
  }

  getBestRecord(): number {
    const row = this.stmtBestRecord.get() as { best: number | null } | undefined;
    return row?.best ?? 0;
  }

  addActionLog(log: ActionLog): void {
    this.stmtInsertLog.run(log.timestamp, log.type, log.content);
  }

  getRecentLogs(limit: number): ActionLog[] {
    return this.stmtRecentLogs.all(limit) as ActionLog[];
  }

  getConfig(): AppConfig {
    const rows = this.stmtGetAllConfig.all() as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return {
      operationMode: (map.get('operationMode') as AppConfig['operationMode']) ?? DEFAULT_CONFIG.operationMode,
      cooldownMinutes: Number(map.get('cooldownMinutes') ?? DEFAULT_CONFIG.cooldownMinutes),
      maxDailyStreams: Number(map.get('maxDailyStreams') ?? DEFAULT_CONFIG.maxDailyStreams),
      llmProvider: (map.get('llmProvider') as AppConfig['llmProvider']) ?? DEFAULT_CONFIG.llmProvider,
      llmModel: map.get('llmModel') ?? DEFAULT_CONFIG.llmModel,
      voicevoxSpeakerId: Number(map.get('voicevoxSpeakerId') ?? DEFAULT_CONFIG.voicevoxSpeakerId),
      minecraftRenderDistance: Number(map.get('minecraftRenderDistance') ?? DEFAULT_CONFIG.minecraftRenderDistance),
      streamTitleTemplate: map.get('streamTitleTemplate') ?? DEFAULT_CONFIG.streamTitleTemplate,
      streamDescriptionTemplate: map.get('streamDescriptionTemplate') ?? DEFAULT_CONFIG.streamDescriptionTemplate,
    };
  }

  updateConfig(partial: Partial<AppConfig>): void {
    const save = this.db.transaction(() => {
      for (const [key, value] of Object.entries(partial)) {
        this.stmtSetConfig.run(key, String(value));
      }
    });
    save();
  }
}
