import { writeFileSync } from 'fs';
import type { AvatarState } from './avatar.js';

export const EXPRESSION_FILE = '/tmp/ai-minecraft-avatar-expr.txt';
export const AVATAR_PIPE_PATH = '/tmp/ai-minecraft-avatar.pipe';
export const AVATAR_WIDTH = 300;
export const AVATAR_HEIGHT = 400;
export const AVATAR_FPS = 5;

export interface AvatarRendererDeps {
  writeExpression: (filePath: string, expression: string) => void;
}

const defaultDeps: AvatarRendererDeps = {
  writeExpression: (filePath, expression) =>
    writeFileSync(filePath, expression, 'utf-8'),
};

/**
 * AvatarState の現在の表情をファイルに書き出す。
 * 外部の avatar-writer.sh がこのファイルを読み取り、
 * 対応する PNG を RGBA 生データに変換して named pipe に書く。
 * FFmpeg はその pipe を rawvideo 入力としてオーバーレイ合成する。
 */
export class AvatarRenderer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastExpression = '';

  constructor(
    private readonly avatarState: AvatarState,
    private readonly basePath: string,
    private readonly deps: AvatarRendererDeps = defaultDeps,
  ) {}

  start(): void {
    if (this.timer) return;

    this.writeCurrentExpression();

    this.timer = setInterval(() => {
      this.avatarState.tick();
      this.writeCurrentExpression();
    }, 1000 / AVATAR_FPS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  private writeCurrentExpression(): void {
    const expr = this.avatarState.getExpression();
    const mouth = this.avatarState.isMouthOpen() ? 'open' : 'closed';
    const key = `${expr}_${mouth}`;

    if (key === this.lastExpression) return;

    this.lastExpression = key;
    const imagePath = `${this.basePath}/${key}.png`;

    try {
      this.deps.writeExpression(EXPRESSION_FILE, imagePath);
    } catch {
      // Best effort: if write fails, keep previous expression
    }
  }

  getCurrentExpression(): string {
    return this.lastExpression;
  }
}
