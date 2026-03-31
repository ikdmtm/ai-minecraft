import type { SharedStateBus, CognitiveThreatLevel } from './sharedState.js';
import type { ReflexLayer } from './reflexLayer.js';
import type { LLMApiAdapter } from '../llm/client.js';
import type { ThreatLevel } from '../types/llm.js';

const TACTICAL_INTERVAL_MS = 4_000;
const TACTICAL_TIMEOUT_MS = 8_000;
const STAGNATION_WARN_MINUTES = 40;

export interface TacticalOutput {
  goalAdjustment: string | null;
  commentary: string;
  threatAssessment: CognitiveThreatLevel;
  emotionShift: { valence?: number; arousal?: number } | null;
}

export interface TacticalLayerEvents {
  onCommentary: (text: string) => void;
  onGoalAdjusted: (goal: string) => void;
}

export class TacticalLayer {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private adapter: LLMApiAdapter;
  private shared: SharedStateBus;
  private reflexLayer: ReflexLayer;
  private events: TacticalLayerEvents;
  private consecutiveErrors = 0;

  constructor(
    adapter: LLMApiAdapter,
    shared: SharedStateBus,
    reflexLayer: ReflexLayer,
    events: TacticalLayerEvents,
  ) {
    this.adapter = adapter;
    this.shared = shared;
    this.reflexLayer = reflexLayer;
    this.events = events;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const delay = TACTICAL_INTERVAL_MS + Math.random() * 1000;
    this.timer = setTimeout(() => this.runCycle(), delay);
  }

  private async runCycle(): Promise<void> {
    if (!this.running) return;

    try {
      const state = this.shared.get();
      const sensors = this.reflexLayer.getSensors();
      const recentEvents = this.shared.getRecentEvents(30_000);

      const prompt = this.buildTacticalPrompt(state, sensors, recentEvents);
      const rawResponse = await callWithTimeout(
        () => this.adapter.call(this.buildSystemPrompt(), prompt),
        TACTICAL_TIMEOUT_MS,
      );

      const output = this.parseTacticalResponse(rawResponse);
      this.applyOutput(output);
      this.consecutiveErrors = 0;
    } catch (e) {
      this.consecutiveErrors++;
      console.error(`[Tactical] Error (${this.consecutiveErrors}): ${e instanceof Error ? e.message : e}`);
    } finally {
      this.scheduleNext();
    }
  }

  private buildSystemPrompt(): string {
    const emotionLabel = this.shared.getEmotionLabel();
    return `あなたは「星守レイ」です。Minecraft ハードコアモードをプレイする AI VTuber です。
あなたは今「${emotionLabel}」な気分です。

【役割】リアルタイムの状況評価と短い実況コメントの生成。
【重要】応答は必ず以下の JSON のみを返してください。

\`\`\`json
{
  "goal_adjustment": null,
  "commentary": "短い実況（1〜2文）",
  "threat_assessment": "safe",
  "emotion_shift": null
}
\`\`\`

- goal_adjustment: 現在の目標を変更すべき場合のみ文字列で指定。不要なら null
- commentary: 今この瞬間に自然に口にする言葉。テンプレートではなく状況に応じた生きた言葉
- threat_assessment: "safe" / "caution" / "danger" / "critical"
- emotion_shift: { "valence": 0.1, "arousal": -0.1 } のように感情変化がある場合のみ。不要なら null

【キャラクター】
- 落ち着いた口調だが、危機には焦りが出る
- 視聴者に向けて思考をそのまま言語化
- 同じフレーズの繰り返しを避ける`;
  }

  private buildTacticalPrompt(
    state: ReturnType<SharedStateBus['get']>,
    sensors: ReturnType<ReflexLayer['getSensors']>,
    events: ReturnType<SharedStateBus['getRecentEvents']>,
  ): string {
    const eventSummary = events.slice(-8).map(e => `[${e.type}] ${e.detail}`).join('\n');
    const survivalMinutes = Math.round(this.shared.getSurvivalMinutes());

    const stagnationWarning = this.detectStagnation(survivalMinutes, state);

    return JSON.stringify({
      hp: sensors.hp,
      hunger: sensors.hunger,
      is_night: sensors.isNight,
      current_goal: state.currentGoal || '(未設定)',
      reflex_state: state.reflexState,
      threat_level: state.threatLevel,
      nearby_hostiles: sensors.nearbyEntities
        .filter(e => e.isHostile)
        .slice(0, 3)
        .map(e => `${e.type} ${e.distance}m ${e.direction}`),
      inventory_has_food: sensors.hasFood,
      survival_minutes: survivalMinutes,
      recent_events: eventSummary || '(なし)',
      emotion: this.shared.getEmotionLabel(),
      ...(stagnationWarning ? { stagnation_warning: stagnationWarning } : {}),
    }, null, 2);
  }

  private lastGoalChangeMinute = 0;

  private detectStagnation(survivalMinutes: number, state: ReturnType<SharedStateBus['get']>): string | null {
    if (state.currentGoal !== this.lastKnownGoal) {
      this.lastKnownGoal = state.currentGoal;
      this.lastGoalChangeMinute = survivalMinutes;
    }

    const minutesSinceGoalChange = survivalMinutes - this.lastGoalChangeMinute;
    if (minutesSinceGoalChange >= STAGNATION_WARN_MINUTES) {
      return `同じ目標「${state.currentGoal}」が${minutesSinceGoalChange}分間変わっていません。配信が単調にならないよう、新しいアプローチや別の目標を検討してください。`;
    }
    return null;
  }

  private lastKnownGoal = '';

  private parseTacticalResponse(raw: string): TacticalOutput {
    const jsonStr = extractJson(raw);
    if (!jsonStr) {
      return {
        goalAdjustment: null,
        commentary: '',
        threatAssessment: this.shared.get().threatLevel,
        emotionShift: null,
      };
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        goalAdjustment: parsed.goal_adjustment || null,
        commentary: parsed.commentary || '',
        threatAssessment: validateThreat(parsed.threat_assessment),
        emotionShift: parsed.emotion_shift || null,
      };
    } catch {
      return {
        goalAdjustment: null,
        commentary: '',
        threatAssessment: this.shared.get().threatLevel,
        emotionShift: null,
      };
    }
  }

  private applyOutput(output: TacticalOutput): void {
    if (output.goalAdjustment) {
      this.shared.setGoal(output.goalAdjustment);
      this.events.onGoalAdjusted(output.goalAdjustment);
      this.reflexLayer.interruptCurrentAction();
    }

    if (output.commentary) {
      this.shared.setCommentary(output.commentary);
      this.events.onCommentary(output.commentary);
    }

    if (output.emotionShift) {
      this.shared.updateEmotion(
        output.emotionShift,
        output.goalAdjustment ? 'tactical_goal_change' : 'tactical_update',
      );
    }

    this.shared.markTacticalUpdate();
  }
}

function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  if (trimmed.startsWith('{')) return trimmed;
  return null;
}

function validateThreat(value: unknown): CognitiveThreatLevel {
  const valid = ['safe', 'caution', 'danger', 'critical'];
  if (typeof value === 'string' && valid.includes(value)) return value as CognitiveThreatLevel;
  return 'safe';
}

function callWithTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tactical timeout (${ms}ms)`)), ms);
    fn().then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}
