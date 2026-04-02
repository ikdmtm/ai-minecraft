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

const MAX_COMMENTARY_LINE_LENGTH = 26;
const MAX_COMMENTARY_LINES = 3;

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

export function formatCommentary(text: string): string {
  if (!text) return '';

  const normalized = text.replace(/\r\n/g, '\n').trim();
  const sourceLines = normalized.split('\n').flatMap((line) => wrapLine(line, MAX_COMMENTARY_LINE_LENGTH));
  const limitedLines = sourceLines.slice(0, MAX_COMMENTARY_LINES);
  const truncated = sourceLines.length > MAX_COMMENTARY_LINES;

  if (limitedLines.length === 0) {
    return '';
  }

  if (truncated) {
    const lastIndex = limitedLines.length - 1;
    limitedLines[lastIndex] = appendEllipsis(limitedLines[lastIndex], MAX_COMMENTARY_LINE_LENGTH);
  }

  return limitedLines.join('\n');
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
    return formatCommentary(this.data.commentary);
  }
}

function wrapLine(line: string, maxLength: number): string[] {
  if (!line) return [''];

  const result: string[] = [];
  let rest = line.trim();

  while (rest.length > maxLength) {
    const candidate = rest.slice(0, maxLength + 1);
    const breakAtWhitespace = Math.max(candidate.lastIndexOf(' '), candidate.lastIndexOf('　'));
    const cut = breakAtWhitespace >= Math.floor(maxLength * 0.6) ? breakAtWhitespace : maxLength;
    result.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) {
    result.push(rest);
  }

  return result.length > 0 ? result : [''];
}

function appendEllipsis(line: string, maxLength: number): string {
  if (line.length >= maxLength) {
    return `${line.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }
  return `${line}…`;
}
