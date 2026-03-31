import type { Position } from '../types/gameState.js';

export type CognitiveThreatLevel = 'safe' | 'caution' | 'danger' | 'critical';

export interface EmotionalState {
  valence: number;    // -1.0 (unhappy) ~ +1.0 (happy)
  arousal: number;    // 0 (calm) ~ 1.0 (excited)
  dominance: number;  // 0 (anxious) ~ 1.0 (confident)
  recentTrigger: string;
}

export interface WorldKnowledge {
  basePosition: Position | null;
  hasBed: boolean;
  hasFurnace: boolean;
  hasCraftingTable: boolean;
  discoveredStructures: Array<{ type: string; position: Position; discoveredAt: number }>;
  dangerZones: Array<{ position: Position; reason: string; expiry: number }>;
  resourceLocations: Array<{ type: string; position: Position; lastSeen: number }>;
}

export interface GameEvent {
  timestamp: number;
  type: string;
  detail: string;
  importance: 'low' | 'medium' | 'high' | 'critical';
}

export interface SkillRef {
  id: string;
  name: string;
  description: string;
}

export type ReflexState =
  | 'idle'
  | 'exploring'
  | 'mining'
  | 'crafting'
  | 'combat'
  | 'fleeing'
  | 'eating'
  | 'sleeping'
  | 'returning_to_base'
  | 'gathering';

export interface SharedState {
  currentGoal: string;
  subGoals: string[];
  threatLevel: CognitiveThreatLevel;
  emotionalState: EmotionalState;
  worldModel: WorldKnowledge;
  recentEvents: GameEvent[];
  activeSkills: SkillRef[];
  reflexState: ReflexState;
  lastTacticalUpdate: number;
  lastStrategicUpdate: number;
  currentCommentary: string;
  survivalStartTime: number;
  generation: number;
  lessonsThisLife: string[];
}

type StateChangeListener = (field: string, value: unknown) => void;

const MAX_EVENTS = 100;
const MAX_DANGER_ZONES = 50;
const MAX_RESOURCE_LOCATIONS = 100;
const MAX_STRUCTURES = 50;

export class SharedStateBus {
  private state: SharedState;
  private listeners: StateChangeListener[] = [];

  constructor() {
    this.state = this.createDefault();
  }

  private createDefault(): SharedState {
    return {
      currentGoal: '',
      subGoals: [],
      threatLevel: 'safe',
      emotionalState: { valence: 0.3, arousal: 0.2, dominance: 0.5, recentTrigger: 'start' },
      worldModel: {
        basePosition: null,
        hasBed: false,
        hasFurnace: false,
        hasCraftingTable: false,
        discoveredStructures: [],
        dangerZones: [],
        resourceLocations: [],
      },
      recentEvents: [],
      activeSkills: [],
      reflexState: 'idle',
      lastTacticalUpdate: 0,
      lastStrategicUpdate: 0,
      currentCommentary: '',
      survivalStartTime: Date.now(),
      generation: 1,
      lessonsThisLife: [],
    };
  }

  reset(generation: number): void {
    const prev = this.state.emotionalState;
    this.state = this.createDefault();
    this.state.generation = generation;
    this.state.emotionalState = { ...prev, recentTrigger: 'new_life' };
    this.state.survivalStartTime = Date.now();
  }

  get(): Readonly<SharedState> {
    return this.state;
  }

  setGoal(goal: string): void {
    this.state.currentGoal = goal;
    this.notify('currentGoal', goal);
  }

  setSubGoals(goals: string[]): void {
    this.state.subGoals = goals;
    this.notify('subGoals', goals);
  }

  popSubGoal(): string | undefined {
    return this.state.subGoals.shift();
  }

  setThreatLevel(level: CognitiveThreatLevel): void {
    this.state.threatLevel = level;
    this.notify('threatLevel', level);
  }

  setReflexState(s: ReflexState): void {
    this.state.reflexState = s;
    this.notify('reflexState', s);
  }

  updateEmotion(delta: Partial<Omit<EmotionalState, 'recentTrigger'>>, trigger: string): void {
    const e = this.state.emotionalState;
    if (delta.valence !== undefined) e.valence = clamp(e.valence + delta.valence, -1, 1);
    if (delta.arousal !== undefined) e.arousal = clamp(e.arousal + delta.arousal, 0, 1);
    if (delta.dominance !== undefined) e.dominance = clamp(e.dominance + delta.dominance, 0, 1);
    e.recentTrigger = trigger;
    this.notify('emotionalState', e);
  }

  setEmotion(emotion: EmotionalState): void {
    this.state.emotionalState = emotion;
    this.notify('emotionalState', emotion);
  }

  decayEmotion(factor: number = 0.05): void {
    const e = this.state.emotionalState;
    e.valence *= (1 - factor);
    e.arousal *= (1 - factor);
    e.dominance = e.dominance + (0.5 - e.dominance) * factor;
  }

  pushEvent(event: Omit<GameEvent, 'timestamp'>): void {
    const full: GameEvent = { ...event, timestamp: Date.now() };
    this.state.recentEvents.push(full);
    if (this.state.recentEvents.length > MAX_EVENTS) {
      this.state.recentEvents.shift();
    }
    this.notify('recentEvents', full);
  }

  getRecentEvents(windowMs: number = 300_000): GameEvent[] {
    const cutoff = Date.now() - windowMs;
    return this.state.recentEvents.filter(e => e.timestamp > cutoff);
  }

  addDangerZone(position: Position, reason: string, durationMs: number = 60_000): void {
    this.state.worldModel.dangerZones.push({
      position, reason, expiry: Date.now() + durationMs,
    });
    if (this.state.worldModel.dangerZones.length > MAX_DANGER_ZONES) {
      this.state.worldModel.dangerZones.shift();
    }
  }

  addResourceLocation(type: string, position: Position): void {
    const existing = this.state.worldModel.resourceLocations.find(
      r => r.type === type && distSq(r.position, position) < 25,
    );
    if (existing) {
      existing.lastSeen = Date.now();
      return;
    }
    this.state.worldModel.resourceLocations.push({ type, position, lastSeen: Date.now() });
    if (this.state.worldModel.resourceLocations.length > MAX_RESOURCE_LOCATIONS) {
      this.state.worldModel.resourceLocations.shift();
    }
  }

  addStructure(type: string, position: Position): void {
    const exists = this.state.worldModel.discoveredStructures.some(
      s => s.type === type && distSq(s.position, position) < 100,
    );
    if (exists) return;
    this.state.worldModel.discoveredStructures.push({ type, position, discoveredAt: Date.now() });
    if (this.state.worldModel.discoveredStructures.length > MAX_STRUCTURES) {
      this.state.worldModel.discoveredStructures.shift();
    }
  }

  setBase(position: Position): void {
    this.state.worldModel.basePosition = position;
    this.notify('worldModel.basePosition', position);
  }

  setCommentary(text: string): void {
    this.state.currentCommentary = text;
    this.notify('currentCommentary', text);
  }

  addLesson(lesson: string): void {
    this.state.lessonsThisLife.push(lesson);
  }

  markTacticalUpdate(): void {
    this.state.lastTacticalUpdate = Date.now();
  }

  markStrategicUpdate(): void {
    this.state.lastStrategicUpdate = Date.now();
  }

  cleanupExpired(): void {
    const now = Date.now();
    this.state.worldModel.dangerZones = this.state.worldModel.dangerZones.filter(
      d => d.expiry > now,
    );
  }

  onStateChange(listener: StateChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  getSurvivalMinutes(): number {
    return (Date.now() - this.state.survivalStartTime) / 60_000;
  }

  getEmotionLabel(): string {
    const e = this.state.emotionalState;
    if (e.valence > 0.5 && e.arousal > 0.5) return 'excited';
    if (e.valence > 0.3 && e.arousal < 0.3) return 'content';
    if (e.valence < -0.5 && e.arousal > 0.5) return 'panicked';
    if (e.valence < -0.3 && e.arousal < 0.3) return 'sad';
    if (e.dominance < 0.3 && e.arousal > 0.5) return 'anxious';
    if (e.dominance > 0.7) return 'confident';
    return 'neutral';
  }

  private notify(field: string, value: unknown): void {
    for (const l of this.listeners) {
      try { l(field, value); } catch { /* ignore listener errors */ }
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function distSq(a: Position, b: Position): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}
