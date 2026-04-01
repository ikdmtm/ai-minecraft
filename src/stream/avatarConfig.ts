import fs from 'fs';
import path from 'path';

const REQUIRED_FILES = ['normal_closed.png', 'normal_open.png'];

function isAvatarAssetDirectory(candidate: string): boolean {
  if (!fs.existsSync(candidate)) {
    return false;
  }

  return REQUIRED_FILES.every((file) => fs.existsSync(path.join(candidate, file)));
}

export function resolveAvatarBasePath(explicitPath = process.env.AVATAR_BASE_PATH): string {
  const candidates = [
    explicitPath?.trim(),
    path.join(process.cwd(), 'assets', 'avatar', 'processed'),
    path.join(process.cwd(), 'assets', 'avatar', 'original'),
    path.join(process.cwd(), 'assets', 'avatar'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (isAvatarAssetDirectory(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Avatar assets not found. looked in: ${candidates.join(', ')}`);
}
