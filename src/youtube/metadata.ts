import { formatSurvivalTime } from '../stream/overlay.js';

export interface StreamMetadataInput {
  generation: number;
  bestRecordMinutes: number;
  totalDeaths: number;
  descriptionTemplate: string;
}

export interface ThumbnailInput {
  backgroundPath: string;
  avatarPath: string;
  outputPath: string;
  generation: number;
  isNewRecord: boolean;
  fontPath: string;
}

export interface ShellCommand {
  command: string;
  args: string[];
}

export function buildStreamTitle(input: { generation: number; template: string }): string {
  return input.template.replace('{世代番号}', String(input.generation));
}

/** 配信中のタイトル（生存分数を含む）。5分ごとの更新用。 */
export function buildStreamTitleLive(input: {
  generation: number;
  survivalMinutes: number;
  baseTemplate: string;
}): string {
  const base = buildStreamTitle({ generation: input.generation, template: input.baseTemplate });
  return `${base} 🔴 ${input.survivalMinutes}分生存中`;
}

export const DEFAULT_STREAM_TITLE_TEMPLATE =
  '【AI Minecraft】星守レイのハードコア生存実験 #Gen{世代番号}';

export const DEFAULT_STREAM_DESCRIPTION_TEMPLATE = `星守レイのハードコア自動配信 — 第{世代番号}世代
最高記録: {最高記録}
累計死亡: {累計死亡}回`;

export function buildStreamDescription(input: StreamMetadataInput): string {
  return input.descriptionTemplate
    .replace('{世代番号}', String(input.generation))
    .replace('{最高記録}', formatSurvivalTime(input.bestRecordMinutes))
    .replace('{累計死亡}', String(input.totalDeaths));
}

export function buildTags(): string[] {
  return [
    'Minecraft',
    'マインクラフト',
    'AI',
    'VTuber',
    'ハードコア',
    '星守レイ',
    'AIゲーム実況',
    '24時間配信',
    'サバイバル',
  ];
}

/**
 * ImageMagick convert コマンドを構築する。
 * 1280x720 のサムネイルを生成: 背景 + アバター + テキストオーバーレイ
 */
export function buildThumbnailCommand(input: ThumbnailInput): ShellCommand {
  const args: string[] = [
    input.backgroundPath,
    '-resize', '1280x720!',

    // アバター合成（右寄せ）
    input.avatarPath,
    '-gravity', 'east',
    '-geometry', '+20+0',
    '-composite',

    // 固定タイトル（左上）
    '-gravity', 'northwest',
    '-font', input.fontPath,
    '-pointsize', '48',
    '-fill', 'white',
    '-stroke', 'black',
    '-strokewidth', '3',
    '-annotate', '+30+30', 'AI ハードコア生存実験',

    // 世代番号（中央下）
    '-gravity', 'south',
    '-pointsize', '72',
    '-fill', '#FFD700',
    '-stroke', 'black',
    '-strokewidth', '4',
    '-annotate', '+0+40', `#Gen${input.generation}`,
  ];

  if (input.isNewRecord) {
    args.push(
      '-gravity', 'northeast',
      '-pointsize', '36',
      '-fill', '#FF4444',
      '-stroke', 'white',
      '-strokewidth', '2',
      '-annotate', '+30+30', '🔥 記録更新中！',
    );
  }

  args.push(input.outputPath);

  return { command: 'convert', args };
}
