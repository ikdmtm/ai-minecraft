import { z } from 'zod';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';

const envSchema = z.object({
  llmProvider: z.enum(['anthropic', 'openai']),
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  youtubeClientId: z.string().optional(),
  youtubeClientSecret: z.string().optional(),
  youtubeRefreshToken: z.string().optional(),
  minecraftHost: z.string(),
  minecraftPort: z.number().int().positive(),
  voicevoxHost: z.string().url(),
  dbPath: z.string(),
  dashboardPort: z.number().int().positive(),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadEnvConfig(
  env: Record<string, string | undefined>,
): Result<EnvConfig> {
  const raw = {
    llmProvider: env.LLM_PROVIDER,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    youtubeClientId: env.YOUTUBE_CLIENT_ID,
    youtubeClientSecret: env.YOUTUBE_CLIENT_SECRET,
    youtubeRefreshToken: env.YOUTUBE_REFRESH_TOKEN,
    minecraftHost: env.MINECRAFT_HOST,
    minecraftPort: safeParseInt(env.MINECRAFT_PORT),
    voicevoxHost: env.VOICEVOX_HOST,
    dbPath: env.DB_PATH,
    dashboardPort: safeParseInt(env.DASHBOARD_PORT),
  };

  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return err(`Invalid config: ${messages}`);
  }

  return ok(result.data);
}

function safeParseInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (Number.isNaN(n)) return undefined;
  return n;
}
