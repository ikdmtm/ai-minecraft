import { writeFileSync } from 'fs';

export interface HudData {
  health: number;
  maxHealth: number;
  hunger: number;
  position: { x: number; y: number; z: number };
  generation: number;
  survivalStartTime: number;
  bestRecordMinutes: number;
  currentGoal: string;
  threatLevel: string;
  reflexState: string;
  commentary: string;
  emotionLabel: string;
}

export interface HudWriterDeps {
  writeFile: (path: string, content: string) => void;
}

export interface HudFilePaths {
  stats: string;
  info: string;
  goal: string;
  commentary: string;
}

const MAX_COMMENTARY_LENGTH = 80;

const THREAT_DISPLAY: Record<string, string> = {
  safe: 'SAFE',
  caution: 'CAUTION',
  danger: 'DANGER',
  critical: 'CRITICAL',
};

const defaultDeps: HudWriterDeps = {
  writeFile: (path, content) => writeFileSync(path, content, 'utf-8'),
};

export function formatHealthBar(health: number, maxHealth: number): string {
  const hp = Math.round(health);
  return `HP ${String(hp).padStart(2)}/${maxHealth}`;
}

export function formatHungerBar(hunger: number): string {
  return `Food ${String(hunger).padStart(2)}/20`;
}

export function formatSurvivalDuration(startTime: number): string {
  const elapsed = Math.max(0, Date.now() - startTime);
  const totalSeconds = Math.floor(elapsed / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatPosition(pos: { x: number; y: number; z: number }): string {
  return `X:${Math.round(pos.x)} Y:${Math.round(pos.y)} Z:${Math.round(pos.z)}`;
}

export class HudWriter {
  private data: HudData;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly outputDir: string;
  private readonly deps: HudWriterDeps;
  private readonly intervalMs: number;

  constructor(
    outputDir: string = '/tmp',
    deps: HudWriterDeps = defaultDeps,
    intervalMs: number = 250,
  ) {
    this.outputDir = outputDir;
    this.deps = deps;
    this.intervalMs = intervalMs;
    this.data = this.createDefault();
  }

  private createDefault(): HudData {
    return {
      health: 20,
      maxHealth: 20,
      hunger: 20,
      position: { x: 0, y: 64, z: 0 },
      generation: 1,
      survivalStartTime: Date.now(),
      bestRecordMinutes: 0,
      currentGoal: '',
      threatLevel: 'safe',
      reflexState: 'idle',
      commentary: '',
      emotionLabel: 'neutral',
    };
  }

  update(data: Partial<HudData>): void {
    Object.assign(this.data, data);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  flush(): void {
    const paths = this.getFilePaths();

    try {
      this.deps.writeFile(paths.stats, this.buildStatsContent());
      this.deps.writeFile(paths.info, this.buildInfoContent());
      this.deps.writeFile(paths.goal, this.buildGoalContent());
      this.deps.writeFile(paths.commentary, this.buildCommentaryContent());
    } catch {
      // best effort
    }
  }

  getFilePaths(): HudFilePaths {
    return {
      stats: `${this.outputDir}/ai-mc-hud-stats.txt`,
      info: `${this.outputDir}/ai-mc-hud-info.txt`,
      goal: `${this.outputDir}/ai-mc-hud-goal.txt`,
      commentary: `${this.outputDir}/ai-mc-hud-commentary.txt`,
    };
  }

  private buildStatsContent(): string {
    const hp = formatHealthBar(this.data.health, this.data.maxHealth);
    const food = formatHungerBar(this.data.hunger);
    const pos = formatPosition(this.data.position);
    return `${hp}  ${food}  ${pos}`;
  }

  private buildInfoContent(): string {
    const gen = `Gen #${this.data.generation}`;
    const survival = formatSurvivalDuration(this.data.survivalStartTime);
    const threat = THREAT_DISPLAY[this.data.threatLevel] || this.data.threatLevel.toUpperCase();
    return `${gen} | ${survival} | ${threat}`;
  }

  private buildGoalContent(): string {
    if (!this.data.currentGoal) return '';
    return this.data.currentGoal;
  }

  private buildCommentaryContent(): string {
    if (!this.data.commentary) return '';
    if (this.data.commentary.length > MAX_COMMENTARY_LENGTH) {
      return this.data.commentary.slice(0, MAX_COMMENTARY_LENGTH - 1) + '…';
    }
    return this.data.commentary;
  }
}
