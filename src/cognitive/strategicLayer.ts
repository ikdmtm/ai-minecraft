import type { SharedStateBus } from './sharedState.js';
import type { LLMApiAdapter } from '../llm/client.js';
import type { BotSensors } from '../bot/types.js';
import type { DeathRecord } from '../types/gameState.js';
import { REI_PERSONA_GUIDELINES, REI_SYSTEM_INTRO } from '../persona/rei.js';

const STRATEGIC_INTERVAL_MS = 45_000;
const STRATEGIC_TIMEOUT_MS = 30_000;

export interface StrategicOutput {
  mainGoal: string;
  subGoals: string[];
  progressAssessment: string;
  lessonsLearned: string[];
  personalityNote: string;
}

export interface StrategicLayerDeps {
  adapter: LLMApiAdapter;
  shared: SharedStateBus;
  getSensors: () => BotSensors;
  getInventorySummary: () => string[];
  getDeathHistory: () => DeathRecord[];
  getSkillSummaries: () => string[];
  onGoalSet: (goal: string) => void;
  onSubGoalsSet: (goals: string[]) => void;
}

export class StrategicLayer {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deps: StrategicLayerDeps;
  private consecutiveErrors = 0;

  constructor(deps: StrategicLayerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(5_000);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delay?: number): void {
    if (!this.running) return;
    const d = delay ?? STRATEGIC_INTERVAL_MS + Math.random() * 5_000;
    this.timer = setTimeout(() => this.runCycle(), d);
  }

  private async runCycle(): Promise<void> {
    if (!this.running) return;

    try {
      const systemPrompt = this.buildSystemPrompt();
      const userMessage = this.buildUserMessage();

      const rawResponse = await callWithTimeout(
        () => this.deps.adapter.call(systemPrompt, userMessage),
        STRATEGIC_TIMEOUT_MS,
      );

      const output = this.parseStrategicResponse(rawResponse);
      this.applyOutput(output);
      this.consecutiveErrors = 0;
    } catch (e) {
      this.consecutiveErrors++;
      console.error(`[Strategic] Error (${this.consecutiveErrors}): ${e instanceof Error ? e.message : e}`);
    } finally {
      this.scheduleNext();
    }
  }

  private buildSystemPrompt(): string {
    const shared = this.deps.shared;
    const emotionLabel = shared.getEmotionLabel();
    const lessons = shared.get().lessonsThisLife;

    return `${REI_SYSTEM_INTRO}
あなたの現在の気分: ${emotionLabel}

${REI_PERSONA_GUIDELINES}

【役割】長期的な戦略計画の立案。
あなたはゲームの全体的な方向性を決める「頭脳」です。

【行動原則】
1. 生存最優先。ハードコアなので死んだら終わり
2. 技術進歩を目指す（木→石→鉄→ダイヤ）
3. 食料と住居の安定を確保してからリスクを取る
4. 配信として面白い展開になるよう、安全になりすぎたらリスクを上げる
5. 過去の死因から学び、同じ失敗を繰り返さない

${lessons.length > 0 ? `【この世代で学んだ教訓】\n${lessons.map(l => `- ${l}`).join('\n')}` : ''}

【出力フォーマット】以下の JSON のみを返してください。

\`\`\`json
{
  "main_goal": "最優先の長期目標（1文）",
  "sub_goals": ["具体的なサブタスク1", "サブタスク2", "..."],
  "progress_assessment": "現在の進捗評価",
  "lessons_learned": ["今回新たに学んだ教訓（あれば）"],
  "personality_note": "今の気持ちや感想（キャラクターとして）"
}
\`\`\`

- main_goal: 反射層が解釈できるシンプルな目標（「木を伐採する」「鉄鉱石を採掘する」「探索する」等）
- main_goal は短く具体的に。複数工程を 1 文に詰め込まない
- インベントリクラフトで作れるのは plank / stick / crafting_table まで。pickaxe / sword / axe / furnace は作業台が必要
- 食料が生肉でも、インベントリにあれば「食べられる食料あり」とみなしてよい。調理は改善策であって絶対条件ではない
- sub_goals: 目標達成のための具体的ステップ
- lessons_learned: この状況から学べること。なければ空配列
- personality_note: キャラクターの内面を表現する短い一言`;
  }

  private buildUserMessage(): string {
    const shared = this.deps.shared;
    const state = shared.get();
    const sensors = this.deps.getSensors();
    const inventory = this.deps.getInventorySummary();
    const deaths = this.deps.getDeathHistory();
    const skills = this.deps.getSkillSummaries();
    const recentEvents = shared.getRecentEvents(120_000);

    return JSON.stringify({
      generation: state.generation,
      survival_minutes: Math.round(shared.getSurvivalMinutes()),
      hp: sensors.hp,
      hunger: sensors.hunger,
      is_night: sensors.isNight,
      current_goal: state.currentGoal || '(未設定)',
      current_reflex_state: state.reflexState,
      threat_level: state.threatLevel,
      inventory: inventory,
      base_known: sensors.baseKnown,
      recent_events: recentEvents.slice(-10).map(
        e => `[${e.type}] ${e.detail}`,
      ),
      death_history: deaths.slice(-5).map(d => ({
        gen: d.generation,
        minutes: d.survivalMinutes,
        cause: d.cause,
        lesson: d.lesson,
      })),
      known_skills: skills.slice(0, 10),
      lessons_this_life: state.lessonsThisLife,
    }, null, 2);
  }

  private parseStrategicResponse(raw: string): StrategicOutput {
    const jsonStr = extractJson(raw);
    if (!jsonStr) {
      return emptyOutput();
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        mainGoal: typeof parsed.main_goal === 'string' ? parsed.main_goal : '',
        subGoals: Array.isArray(parsed.sub_goals) ? parsed.sub_goals.filter((s: unknown) => typeof s === 'string') : [],
        progressAssessment: typeof parsed.progress_assessment === 'string' ? parsed.progress_assessment : '',
        lessonsLearned: Array.isArray(parsed.lessons_learned) ? parsed.lessons_learned.filter((s: unknown) => typeof s === 'string') : [],
        personalityNote: typeof parsed.personality_note === 'string' ? parsed.personality_note : '',
      };
    } catch {
      return emptyOutput();
    }
  }

  private applyOutput(output: StrategicOutput): void {
    const shared = this.deps.shared;

    if (output.mainGoal) {
      shared.setGoal(output.mainGoal);
      this.deps.onGoalSet(output.mainGoal);
    }

    if (output.subGoals.length > 0) {
      shared.setSubGoals(output.subGoals);
      this.deps.onSubGoalsSet(output.subGoals);
    }

    for (const lesson of output.lessonsLearned) {
      if (lesson) shared.addLesson(lesson);
    }

    shared.markStrategicUpdate();
  }
}

function emptyOutput(): StrategicOutput {
  return {
    mainGoal: '',
    subGoals: [],
    progressAssessment: '',
    lessonsLearned: [],
    personalityNote: '',
  };
}

function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  if (trimmed.startsWith('{')) return trimmed;
  return null;
}

function callWithTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Strategic timeout (${ms}ms)`)), ms);
    fn().then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}
