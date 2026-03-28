# 技術設計書: AI Minecraft 配信システム

仕様書（ai_minecraft_stream_spec_hoshimori_rei.md）に基づく実装設計。
本ドキュメントの範囲は「コードをどう分割し、どう繋ぐか」に限定する。

## 1. プロジェクト構成

```
ai-minecraft/
├── package.json
├── tsconfig.json
├── jest.config.ts
├── .env.example
├── docs/
│   └── spec.md                        # 仕様書（既存）
├── assets/
│   ├── avatar/                        # 星守レイ アバター PNG (12枚)
│   └── thumbnail/                     # サムネイルテンプレート素材
├── src/
│   ├── index.ts                       # エントリーポイント
│   ├── types/                         # 共有型定義
│   │   ├── gameState.ts
│   │   ├── llm.ts
│   │   ├── state.ts
│   │   ├── config.ts
│   │   └── events.ts
│   ├── orchestrator/                  # 中央制御・状態機械
│   │   ├── stateMachine.ts
│   │   ├── stateMachine.test.ts
│   │   ├── cycle.ts                   # 1サイクル（§23）の制御
│   │   └── cycle.test.ts
│   ├── bot/                           # Mineflayer ラッパー + リアクティブ層
│   │   ├── client.ts                  # Mineflayer 接続・基本操作
│   │   ├── reactive.ts                # リアクティブ層ルール
│   │   ├── reactive.test.ts
│   │   ├── actionMapper.ts            # steps → Mineflayer API 変換
│   │   ├── actionMapper.test.ts
│   │   ├── gameStateCollector.ts       # ゲーム状態の収集
│   │   └── gameStateCollector.test.ts
│   ├── llm/                           # LLM API 通信
│   │   ├── client.ts                  # API クライアント（Anthropic / OpenAI）
│   │   ├── client.test.ts
│   │   ├── promptBuilder.ts           # ゲーム状態 → LLM プロンプト構築
│   │   ├── promptBuilder.test.ts
│   │   ├── responseParser.ts          # LLM 応答 JSON のパース・バリデーション
│   │   └── responseParser.test.ts
│   ├── tts/                           # VOICEVOX 音声合成
│   │   ├── voicevox.ts                # VOICEVOX HTTP クライアント
│   │   ├── voicevox.test.ts
│   │   ├── audioQueue.ts              # 音声再生キュー管理
│   │   └── audioQueue.test.ts
│   ├── stream/                        # FFmpeg 映像・音声配信
│   │   ├── ffmpeg.ts                  # FFmpeg プロセス管理
│   │   ├── overlay.ts                 # オーバーレイ PNG 生成（node-canvas）
│   │   ├── overlay.test.ts
│   │   ├── avatar.ts                  # アバター表情状態管理
│   │   └── avatar.test.ts
│   ├── youtube/                       # YouTube API
│   │   ├── api.ts                     # 配信枠 CRUD・サムネイルアップロード
│   │   ├── metadata.ts                # タイトル・概要欄・タグ生成
│   │   └── metadata.test.ts
│   ├── db/                            # SQLite データ層
│   │   ├── database.ts                # 接続管理（WAL モード）
│   │   ├── schema.ts                  # テーブル定義・マイグレーション
│   │   ├── repository.ts              # データアクセス
│   │   └── repository.test.ts
│   ├── health/                        # ヘルスチェック
│   │   ├── checker.ts                 # 9項目のヘルスチェック実行
│   │   ├── checker.test.ts
│   │   └── recovery.ts               # 復旧アクション実行
│   ├── dashboard/                     # 運用ダッシュボード
│   │   ├── server.ts                  # Express.js サーバー
│   │   ├── routes.ts                  # API ルート定義
│   │   ├── routes.test.ts
│   │   └── public/
│   │       └── index.html             # ダッシュボード UI
│   └── config/                        # 設定管理
│       ├── schema.ts                  # 設定スキーマ（Zod）
│       └── loader.ts                  # 環境変数 + SQLite からの設定読み込み
├── scripts/
│   ├── setup-instance.sh              # EC2 初期セットアップ
│   └── generate-thumbnail.sh          # ImageMagick サムネイル生成
└── systemd/
    ├── minecraft-server.service
    ├── minecraft-client.service
    ├── voicevox.service
    ├── orchestrator.service
    └── ffmpeg-stream.service
```

## 2. モジュール責務と境界

各モジュールは明確な責務を持ち、他モジュールとは型定義（`src/types/`）を介してのみ結合する。

```
                    ┌─────────────┐
                    │ orchestrator│  中央制御。他の全モジュールを呼ぶ唯一の場所
                    │ stateMachine│
                    │   cycle     │
                    └──────┬──────┘
          ┌────────┬───────┼───────┬────────┬────────┐
          ↓        ↓       ↓       ↓        ↓        ↓
       ┌─────┐ ┌─────┐ ┌─────┐ ┌──────┐ ┌──────┐ ┌──────┐
       │ bot │ │ llm │ │ tts │ │stream│ │  yt  │ │  db  │
       └─────┘ └─────┘ └─────┘ └──────┘ └──────┘ └──────┘

       health, dashboard, config は orchestrator に注入される補助モジュール
```

### 依存ルール
- `types/` → 他のどのモジュールにも依存しない（最下層）
- `bot/`, `llm/`, `tts/`, `stream/`, `youtube/`, `db/` → `types/` のみに依存
- `health/`, `config/` → `types/` のみに依存
- `orchestrator/` → 上記すべてに依存する（唯一の結合点）
- `dashboard/` → `orchestrator/` と `db/` に依存（状態の読み取りと設定変更）
- モジュール間の横の依存は禁止（例: `bot/` が `llm/` を直接呼ぶことはない）

## 3. 共有型定義（src/types/）

### gameState.ts

```typescript
export interface Position {
  x: number;
  y: number;
  z: number;
}

export interface Equipment {
  hand: string | null;
  helmet: string | null;
  chestplate: string | null;
  leggings: string | null;
  boots: string | null;
}

export interface NearbyEntity {
  type: string;
  distance: number;
  direction: string;
}

export interface NearbyBlock {
  type: string;
  distance: number;
  direction: string;
}

export interface PlayerState {
  hp: number;
  maxHp: number;
  hunger: number;
  position: Position;
  biome: string;
  equipment: Equipment;
  inventorySummary: string[];
}

export interface WorldState {
  timeOfDay: 'day' | 'night' | 'dawn' | 'dusk';
  minecraftTime: number;
  weather: 'clear' | 'rain' | 'thunder';
  lightLevel: number;
  nearbyEntities: NearbyEntity[];
  nearbyBlocksOfInterest: NearbyBlock[];
}

export interface BaseInfo {
  known: boolean;
  position: Position | null;
  distance: number | null;
  hasBed: boolean;
  hasFurnace: boolean;
  hasCraftingTable: boolean;
}

export interface PacingInfo {
  currentActionCategory: ActionCategory;
  categoryDurationMinutes: number;
  survivalTimeMinutes: number;
  progressPhase: ProgressPhase;
  bestRecordMinutes: number;
}

export interface PreviousPlan {
  goal: string;
  status: 'in_progress' | 'completed' | 'failed' | 'interrupted';
  progress: string;
}

export interface RecentEvent {
  time: string;
  event: string;
  detail: string;
}

export interface DeathRecord {
  generation: number;
  survivalMinutes: number;
  cause: string;
  lesson: string;
}

export interface Memory {
  totalDeaths: number;
  bestRecordMinutes: number;
  recentDeaths: DeathRecord[];
}

export interface GameState {
  player: PlayerState;
  world: WorldState;
  base: BaseInfo;
  pacing: PacingInfo;
  previousPlan: PreviousPlan | null;
  recentEvents: RecentEvent[];
  stagnationWarning: boolean;
  memory: Memory;
}

export type ActionCategory =
  | 'mining' | 'building' | 'exploring' | 'combat'
  | 'waiting' | 'moving' | 'crafting' | 'farming';

export type ProgressPhase = 'early' | 'stable' | 'advanced' | 'challenge';
```

### llm.ts

```typescript
export interface LLMInput {
  gameState: GameState;
}

export interface ActionPlan {
  goal: string;
  reason: string;
  steps: string[];
}

export interface LLMOutput {
  action: ActionPlan;
  commentary: string;
  currentGoalUpdate: string | null;
  threatLevel: ThreatLevel;
}

export type ThreatLevel = 'low' | 'medium' | 'high' | 'critical';
```

### state.ts

```typescript
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
```

### events.ts

```typescript
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
```

### config.ts

```typescript
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
  youtubeStreamKey: string;
}
```

## 4. モジュール別インターフェース

各モジュールが外部に公開するインターフェース。orchestrator はこれらのインターフェースのみを通じて各モジュールと通信する。

### bot/

```typescript
export interface IBot {
  connect(host: string, port: number): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  getGameState(): GameState;
  executeSteps(steps: string[]): Promise<StepResult[]>;
  cancelCurrentAction(): void;

  onDeath(callback: (cause: string) => void): void;
  onReactiveAction(callback: (event: RecentEvent) => void): void;
  getLastActionTimestamp(): number;
}

export interface StepResult {
  step: string;
  status: 'completed' | 'failed' | 'interrupted' | 'unmapped';
  error?: string;
}
```

### llm/

```typescript
export interface ILLMClient {
  call(input: GameState): Promise<LLMOutput>;
  generateDeathLesson(context: DeathContext): Promise<string>;
  getConsecutiveFailures(): number;
}

export interface DeathContext {
  position: Position;
  cause: string;
  recentActions: RecentEvent[];
  survivalMinutes: number;
}
```

### tts/

```typescript
export interface ITTS {
  synthesize(text: string): Promise<Buffer>;
  isHealthy(): Promise<boolean>;
}

export interface IAudioQueue {
  enqueue(audio: Buffer): void;
  isPlaying(): boolean;
  clear(): void;
  onPlaybackStart(callback: () => void): void;
  onPlaybackEnd(callback: () => void): void;
}
```

### stream/

```typescript
export interface IStreamManager {
  start(config: StreamConfig): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  switchScene(scene: 'live' | 'death' | 'waiting'): void;
}

export interface IOverlayRenderer {
  update(state: OverlayState): Promise<void>;
}

export interface OverlayState {
  survivalTime: string;
  bestRecord: string;
  currentGoal: string;
  threatLevel: ThreatLevel;
  commentary: string;
  avatarExpression: AvatarExpression;
  isSpeaking: boolean;
}

export type AvatarExpression =
  | 'normal' | 'serious' | 'anxious' | 'scared' | 'happy' | 'thinking';

export interface StreamConfig {
  rtmpUrl: string;
  localRecordingPath: string;
}
```

### youtube/

```typescript
export interface IYouTubeAPI {
  createBroadcast(meta: BroadcastMeta): Promise<BroadcastResult>;
  updateBroadcast(id: string, meta: Partial<BroadcastMeta>): Promise<void>;
  transitionToLive(id: string): Promise<void>;
  endBroadcast(id: string): Promise<void>;
  uploadThumbnail(id: string, imagePath: string): Promise<void>;
  getStreamStatus(id: string): Promise<string>;
}

export interface BroadcastMeta {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
}

export interface BroadcastResult {
  broadcastId: string;
  streamKey: string;
  rtmpUrl: string;
}
```

### db/

```typescript
export interface IRepository {
  getState(): Promise<PersistentState>;
  saveState(state: Partial<PersistentState>): Promise<void>;

  addDeathRecord(record: DeathRecord): Promise<void>;
  getRecentDeaths(limit: number): Promise<DeathRecord[]>;
  getBestRecord(): Promise<number>;

  getConfig(): Promise<AppConfig>;
  updateConfig(config: Partial<AppConfig>): Promise<void>;

  addActionLog(log: ActionLog): Promise<void>;
  getRecentLogs(limit: number): Promise<ActionLog[]>;
}

export interface ActionLog {
  timestamp: string;
  type: 'llm_response' | 'reactive_action' | 'state_change' | 'error';
  content: string;
}
```

### health/

```typescript
export interface IHealthChecker {
  runAll(): Promise<HealthReport>;
  runSingle(target: HealthTarget): Promise<HealthResult>;
}

export type HealthTarget =
  | 'minecraft_server' | 'minecraft_client' | 'mineflayer_bot'
  | 'ffmpeg_stream' | 'ffmpeg_recording' | 'voicevox'
  | 'youtube_stream' | 'llm_api' | 'sqlite';

export interface HealthResult {
  target: HealthTarget;
  healthy: boolean;
  message: string;
  consecutiveFailures: number;
}

export interface HealthReport {
  timestamp: string;
  results: HealthResult[];
  allHealthy: boolean;
}
```

## 5. SQLite スキーマ

```sql
CREATE TABLE state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE death_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  generation      INTEGER NOT NULL,
  survival_minutes REAL NOT NULL,
  cause           TEXT NOT NULL,
  lesson          TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE action_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT NOT NULL,
  type       TEXT NOT NULL,
  content    TEXT NOT NULL
);

CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

## 6. テスト戦略（TDD）

### 原則
- **すべてのロジックモジュールはテストを先に書いてから実装する**
- 外部依存（Mineflayer、LLM API、VOICEVOX、YouTube API、FFmpeg）はインターフェースで抽象化し、テスト時はモックに差し替える
- テストが通る最小実装を書き、リファクタリングする（Red → Green → Refactor）

### テスト分類

| 分類 | 対象 | 方法 | 実行タイミング |
|---|---|---|---|
| **Unit** | 純粋ロジック | Jest + モック | 毎コミット |
| **Integration** | モジュール連携 | Jest + テスト用 SQLite | 毎コミット |
| **E2E (ローカル)** | 全体フロー | 実プロセス起動 | 手動 / CI |

### モジュール別のテスト方針

| モジュール | テスト対象 | モックするもの | TDD 適用 |
|---|---|---|---|
| `orchestrator/stateMachine` | 状態遷移の正しさ | 全外部モジュール | **Yes** |
| `orchestrator/cycle` | 1サイクルの制御フロー | bot, llm, tts, stream | **Yes** |
| `bot/reactive` | リアクティブ層の判定ロジック | Mineflayer Bot オブジェクト | **Yes** |
| `bot/actionMapper` | steps → アクション変換 | なし（純粋関数） | **Yes** |
| `bot/gameStateCollector` | ゲーム状態の収集・整形 | Mineflayer Bot オブジェクト | **Yes** |
| `llm/promptBuilder` | GameState → プロンプト文字列 | なし（純粋関数） | **Yes** |
| `llm/responseParser` | JSON パース・バリデーション | なし（純粋関数） | **Yes** |
| `llm/client` | API 呼び出し・リトライ | HTTP クライアント | **Yes** |
| `tts/voicevox` | 音声合成リクエスト | HTTP クライアント | **Yes** |
| `tts/audioQueue` | キュー管理・再生制御 | オーディオ再生 | **Yes** |
| `stream/overlay` | PNG 描画ロジック | node-canvas | **Yes** |
| `stream/avatar` | 表情状態の決定 | なし（純粋関数） | **Yes** |
| `youtube/metadata` | タイトル・概要欄生成 | なし（純粋関数） | **Yes** |
| `db/repository` | CRUD 操作 | なし（テスト用 SQLite） | **Yes** |
| `dashboard/routes` | API レスポンス | repository | **Yes** |
| `health/checker` | 判定ロジック | 各プロセスの存在確認 | **Yes** |
| `bot/client` | Mineflayer 接続 | **モックしない（E2E）** | No |
| `stream/ffmpeg` | FFmpeg 起動 | **モックしない（E2E）** | No |
| `youtube/api` | YouTube API 呼び出し | **モックしない（E2E）** | No |

### モック設計

各外部依存のインターフェース（§4 で定義）に対して、テスト用のモック実装を用意する。

```
src/
├── __mocks__/
│   ├── bot.mock.ts          # IBot のモック
│   ├── llm.mock.ts          # ILLMClient のモック
│   ├── tts.mock.ts          # ITTS, IAudioQueue のモック
│   ├── stream.mock.ts       # IStreamManager のモック
│   ├── youtube.mock.ts      # IYouTubeAPI のモック
│   └── repository.mock.ts   # IRepository のモック（in-memory）
```

### テスト例: 状態遷移

```typescript
// orchestrator/stateMachine.test.ts
describe('StateMachine', () => {
  it('IDLE → BOOTING on START_TRIGGERED', () => {
    const sm = createStateMachine('IDLE', 'MANUAL');
    const next = sm.transition({ type: 'START_TRIGGERED' });
    expect(next).toBe('BOOTING');
  });

  it('DEATH_DETECTED → IDLE in MANUAL mode', () => {
    const sm = createStateMachine('ENDING_STREAM', 'MANUAL');
    const next = sm.transition({ type: 'STREAM_ENDED' });
    expect(next).toBe('IDLE');
  });

  it('DEATH_DETECTED → COOL_DOWN in AUTO mode', () => {
    const sm = createStateMachine('ENDING_STREAM', 'AUTO');
    const next = sm.transition({ type: 'STREAM_ENDED' });
    expect(next).toBe('COOL_DOWN');
  });

  it('rejects invalid transitions', () => {
    const sm = createStateMachine('IDLE', 'MANUAL');
    expect(() => sm.transition({ type: 'DEATH_DETECTED', cause: '' }))
      .toThrow();
  });
});
```

### テスト例: リアクティブ層

```typescript
// bot/reactive.test.ts
describe('ReactiveLayer', () => {
  it('triggers flee when creeper is within 5 blocks', () => {
    const state = createMockPlayerState({
      hp: 20,
      nearbyEntities: [{ type: 'creeper', distance: 4, direction: 'north' }],
    });
    const action = evaluateReactiveRules(state);
    expect(action).toEqual({ type: 'flee', priority: 'highest', from: 'north' });
  });

  it('triggers eat when HP <= 6 and has food', () => {
    const state = createMockPlayerState({
      hp: 6,
      inventorySummary: ['bread x3'],
      nearbyEntities: [],
    });
    const action = evaluateReactiveRules(state);
    expect(action).toEqual({ type: 'eat', priority: 'highest', item: 'bread' });
  });

  it('returns null when no reactive rule matches', () => {
    const state = createMockPlayerState({
      hp: 20,
      nearbyEntities: [{ type: 'cow', distance: 10, direction: 'east' }],
    });
    const action = evaluateReactiveRules(state);
    expect(action).toBeNull();
  });
});
```

### テスト例: LLM レスポンスパーサー

```typescript
// llm/responseParser.test.ts
describe('parseResponse', () => {
  it('parses valid LLM output', () => {
    const raw = JSON.stringify({
      action: { goal: '拠点に戻る', reason: '夜になった', steps: ['拠点へ帰還する'] },
      commentary: '夜だ。帰ろう。',
      current_goal_update: null,
      threat_level: 'medium',
    });
    const result = parseResponse(raw);
    expect(result.ok).toBe(true);
    expect(result.value!.action.goal).toBe('拠点に戻る');
    expect(result.value!.threatLevel).toBe('medium');
  });

  it('returns error for invalid JSON', () => {
    const result = parseResponse('not json');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('parse');
  });

  it('returns error for missing required fields', () => {
    const raw = JSON.stringify({ action: { goal: 'test' } });
    const result = parseResponse(raw);
    expect(result.ok).toBe(false);
  });
});
```

## 7. 動作確認ルール

各スライスの完了時に、ユニットテスト（`npx jest`）に加えて**デモスクリプト**で実際の動作を確認する。

```bash
# テスト実行
npx jest

# デモスクリプト実行（各スライスごとに用意）
npx tsx src/demo-slice0.ts   # DB・設定の読み書き確認
npx tsx src/demo-slice2.ts   # LLM プロンプト構築・レスポンスパース確認
# （以降のスライスも同様）
```

デモスクリプトは本番と同じコードパスを通る。モックは使わない。

## 8. 実装順序（垂直スライス）

各スライスは独立してテスト・動作確認できる単位。前のスライスが完了してから次に進む。

### Slice 0: プロジェクト基盤 [準備] ✅
- package.json, tsconfig.json, jest.config.ts のセットアップ
- 依存パッケージのインストール
- `src/types/` の全型定義
- `src/db/` (SQLite スキーマ + repository)
- `src/config/` (設定スキーマ + ローダー)
- **テスト**: repository の CRUD、設定の読み書き

### Slice 1: Bot 接続 + リアクティブ層 [コアゲーム] ✅
- `src/bot/client.ts` (Mineflayer 接続)
- `src/bot/reactive.ts` (リアクティブ層ルール)
- `src/bot/gameStateCollector.ts` (ゲーム状態収集)
- **テスト**: リアクティブ層の全ルール、ゲーム状態収集
- **動作確認**: ローカル Minecraft サーバーに接続し、bot が生存行動を取る

### Slice 2: LLM 連携 + 行動実行 [AI 思考]
- `src/llm/client.ts` (API クライアント)
- `src/llm/promptBuilder.ts` (プロンプト構築)
- `src/llm/responseParser.ts` (レスポンスパース)
- `src/bot/actionMapper.ts` (steps → Mineflayer)
- `src/orchestrator/cycle.ts` (1 サイクル制御)
- **テスト**: プロンプト構築、レスポンスパース、アクションマッピング、サイクル制御
- **動作確認**: bot が LLM の指示に基づいて行動する

### Slice 3: 音声実況 [声]
- `src/tts/voicevox.ts` (VOICEVOX クライアント)
- `src/tts/audioQueue.ts` (音声キュー)
- **テスト**: 音声合成リクエスト、キュー管理
- **動作確認**: LLM の commentary が音声として再生される

### Slice 4: 映像配信 [配信]
- `src/stream/ffmpeg.ts` (FFmpeg プロセス管理)
- `src/stream/overlay.ts` (UI オーバーレイ描画)
- `src/stream/avatar.ts` (アバター表情管理)
- **テスト**: オーバーレイ描画、アバター表情決定
- **動作確認**: ゲーム画面 + UI + アバター + 音声がローカル録画される

### Slice 5: YouTube 配信 + 死亡→再起動 [運用ループ]
- `src/youtube/api.ts` (YouTube API)
- `src/youtube/metadata.ts` (メタデータ生成)
- `src/orchestrator/stateMachine.ts` (状態機械)
- 死亡検知 → ENDING_STREAM → IDLE の一連フロー
- **テスト**: 状態遷移、メタデータ生成
- **動作確認**: YouTube に実際に配信 → 死亡 → 配信終了

### Slice 6: ヘルスチェック + ダッシュボード [運用]
- `src/health/checker.ts` + `recovery.ts`
- `src/dashboard/server.ts` + `routes.ts` + UI
- **テスト**: ヘルスチェック判定、API ルート
- **動作確認**: ダッシュボードから配信開始・停止・状態確認

### Slice 7: 記憶・学習 + 仕上げ [成長]
- 死亡時の教訓生成（LLM 呼び出し）
- death_history の蓄積と LLM 入力への反映
- サムネイル自動生成
- **テスト**: 教訓生成フロー、記憶の入力反映
- **動作確認**: 死亡→教訓保存→次世代で教訓が反映される

## 8. DI（依存性注入）パターン

テスト容易性のため、全モジュールはインターフェースを通じて依存を受け取る。

```typescript
// orchestrator の初期化例
export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  // ...
}

export interface OrchestratorDeps {
  bot: IBot;
  llm: ILLMClient;
  tts: ITTS;
  audioQueue: IAudioQueue;
  stream: IStreamManager;
  overlay: IOverlayRenderer;
  youtube: IYouTubeAPI;
  repository: IRepository;
  healthChecker: IHealthChecker;
  config: AppConfig;
}
```

本番コードでは実装クラスを注入し、テストコードではモックを注入する。

```typescript
// src/index.ts (本番)
const orchestrator = createOrchestrator({
  bot: new MineflayerBot(),
  llm: new AnthropicClient(config.llmModel),
  tts: new VoicevoxClient(),
  // ...
});

// orchestrator/cycle.test.ts (テスト)
const orchestrator = createOrchestrator({
  bot: createMockBot(),
  llm: createMockLLM(),
  tts: createMockTTS(),
  // ...
});
```

## 9. エラーハンドリング方針

### Result 型
外部 API 呼び出しなど失敗しうる操作は、例外ではなく Result 型で返す。

```typescript
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

### 使用箇所
- `llm/responseParser.ts`: パース結果を `Result<LLMOutput>` で返す
- `llm/client.ts`: API 呼び出し結果を `Result<LLMOutput>` で返す
- `bot/actionMapper.ts`: マッピング結果を `Result<MappedAction>` で返す
- `youtube/api.ts`: API 操作結果を `Result<T>` で返す

### 例外を使う箇所
- プログラムのバグ（型不整合、null アクセスなど）→ そのまま throw して crash
- 設定ファイルの読み込み失敗（起動時）→ throw して起動中止

## 10. パッケージ依存

```json
{
  "dependencies": {
    "mineflayer": "^4",
    "mineflayer-pathfinder": "^2",
    "mineflayer-pvp": "^1",
    "prismarine-viewer": "^1",
    "@anthropic-ai/sdk": "^0",
    "openai": "^4",
    "better-sqlite3": "^11",
    "express": "^4",
    "canvas": "^2",
    "zod": "^3",
    "pino": "^9"
  },
  "devDependencies": {
    "typescript": "^5",
    "jest": "^29",
    "ts-jest": "^29",
    "@types/node": "^22",
    "@types/express": "^4",
    "@types/better-sqlite3": "^7",
    "tsx": "^4"
  }
}
```
