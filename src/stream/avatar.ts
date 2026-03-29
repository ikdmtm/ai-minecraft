import type { ThreatLevel } from '../types/llm.js';

export type AvatarExpression =
  | 'normal'
  | 'serious'
  | 'sad'
  | 'surprised'
  | 'happy'
  | 'thinking';

interface AvatarInput {
  threatLevel: ThreatLevel;
  isSpeaking: boolean;
}

const THREAT_TO_EXPRESSION: Record<ThreatLevel, AvatarExpression> = {
  low: 'normal',
  medium: 'serious',
  high: 'sad',
  critical: 'surprised',
};

/**
 * アバターの表情とリップシンク状態を管理する。
 * 200ms 間隔で tick() を呼び出し、口の開閉を切り替える。
 */
export class AvatarState {
  private expression: AvatarExpression = 'normal';
  private speaking = false;
  private mouthOpen = false;
  private specialExpression: AvatarExpression | null = null;
  private specialTimer: ReturnType<typeof setTimeout> | null = null;

  update(input: AvatarInput): void {
    this.expression = THREAT_TO_EXPRESSION[input.threatLevel];
    this.speaking = input.isSpeaking;
    if (!this.speaking) {
      this.mouthOpen = false;
    }
  }

  triggerSpecial(expression: AvatarExpression, durationMs = 3000): void {
    this.specialExpression = expression;
    if (this.specialTimer) clearTimeout(this.specialTimer);
    this.specialTimer = setTimeout(() => {
      this.specialExpression = null;
      this.specialTimer = null;
    }, durationMs);
  }

  /**
   * 200ms 間隔で呼ばれる。発話中は口の開閉を交互に切り替える。
   */
  tick(): void {
    if (this.speaking) {
      this.mouthOpen = !this.mouthOpen;
    } else {
      this.mouthOpen = false;
    }
  }

  destroy(): void {
    if (this.specialTimer) {
      clearTimeout(this.specialTimer);
      this.specialTimer = null;
    }
  }

  getExpression(): AvatarExpression {
    return this.specialExpression ?? this.expression;
  }

  isMouthOpen(): boolean {
    return this.mouthOpen;
  }

  /**
   * 現在の状態に対応するアバター画像のファイルパスを返す。
   * 形式: {basePath}/{expression}_{open|closed}.png
   */
  getImagePath(basePath: string): string {
    const expr = this.getExpression();
    const mouth = this.mouthOpen ? 'open' : 'closed';
    return `${basePath}/${expr}_${mouth}.png`;
  }
}
