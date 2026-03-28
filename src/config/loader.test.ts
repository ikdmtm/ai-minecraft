import { loadEnvConfig, type EnvConfig } from './loader';

describe('loadEnvConfig', () => {
  it('loads all required values from env', () => {
    const env: Record<string, string> = {
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      MINECRAFT_HOST: 'localhost',
      MINECRAFT_PORT: '25565',
      VOICEVOX_HOST: 'http://localhost:50021',
      DB_PATH: './data/state.db',
      DASHBOARD_PORT: '8080',
    };
    const config = loadEnvConfig(env);
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect(config.value.llmProvider).toBe('anthropic');
    expect(config.value.anthropicApiKey).toBe('sk-ant-test');
    expect(config.value.minecraftPort).toBe(25565);
    expect(config.value.dashboardPort).toBe(8080);
  });

  it('accepts openai provider with openai key', () => {
    const env: Record<string, string> = {
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test',
      MINECRAFT_HOST: 'localhost',
      MINECRAFT_PORT: '25565',
      VOICEVOX_HOST: 'http://localhost:50021',
      DB_PATH: './data/state.db',
      DASHBOARD_PORT: '8080',
    };
    const config = loadEnvConfig(env);
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect(config.value.llmProvider).toBe('openai');
    expect(config.value.openaiApiKey).toBe('sk-test');
  });

  it('uses defaults for optional values', () => {
    const env: Record<string, string> = {
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      MINECRAFT_HOST: 'localhost',
      MINECRAFT_PORT: '25565',
      VOICEVOX_HOST: 'http://localhost:50021',
      DB_PATH: './data/state.db',
      DASHBOARD_PORT: '8080',
    };
    const config = loadEnvConfig(env);
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect(config.value.minecraftHost).toBe('localhost');
  });

  it('returns error when required field is missing', () => {
    const env: Record<string, string> = {
      LLM_PROVIDER: 'anthropic',
    };
    const config = loadEnvConfig(env);
    expect(config.ok).toBe(false);
  });

  it('returns error for invalid LLM_PROVIDER', () => {
    const env: Record<string, string> = {
      LLM_PROVIDER: 'invalid',
      MINECRAFT_HOST: 'localhost',
      MINECRAFT_PORT: '25565',
      VOICEVOX_HOST: 'http://localhost:50021',
      DB_PATH: './data/state.db',
      DASHBOARD_PORT: '8080',
    };
    const config = loadEnvConfig(env);
    expect(config.ok).toBe(false);
  });

  it('returns error for non-numeric port', () => {
    const env: Record<string, string> = {
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      MINECRAFT_HOST: 'localhost',
      MINECRAFT_PORT: 'abc',
      VOICEVOX_HOST: 'http://localhost:50021',
      DB_PATH: './data/state.db',
      DASHBOARD_PORT: '8080',
    };
    const config = loadEnvConfig(env);
    expect(config.ok).toBe(false);
  });
});
