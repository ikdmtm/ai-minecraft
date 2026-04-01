import { createRoutes, type DashboardDeps } from './routes';
import express from 'express';
import request from 'supertest';

function createMockDeps(overrides: Partial<DashboardDeps> = {}): DashboardDeps {
  return {
    getStatus: jest.fn().mockReturnValue({
      state: 'LIVE_RUNNING',
      generation: 13,
      survivalMinutes: 83,
      bestRecordMinutes: 240,
      operationMode: 'MANUAL',
      dailyStreamCount: 2,
      healthStatuses: [
        { name: 'minecraft-server', healthy: true, consecutiveFailures: 0, lastError: null, lastChecked: '' },
        { name: 'voicevox', healthy: true, consecutiveFailures: 0, lastError: null, lastChecked: '' },
      ],
    }),
    triggerStart: jest.fn().mockReturnValue({ ok: true }),
    triggerStop: jest.fn().mockReturnValue({ ok: true }),
    getLogs: jest.fn().mockReturnValue([
      { timestamp: '2026-03-28T14:23:05Z', type: 'llm_response', content: 'test' },
    ]),
    getConfig: jest.fn().mockReturnValue({
      operationMode: 'MANUAL',
      cooldownMinutes: 10,
      maxDailyStreams: 20,
      streamTitleTemplate: 'テスト',
    }),
    updateConfig: jest.fn().mockReturnValue({ ok: true }),
    getDeathHistory: jest.fn().mockReturnValue([
      { generation: 12, survivalMinutes: 45, cause: 'クリーパー爆発', lesson: '夜は拠点に戻る', timestamp: '' },
    ]),
    ...overrides,
  };
}

function createApp(deps?: Partial<DashboardDeps>) {
  const app = express();
  app.use(express.json());
  app.use(createRoutes(createMockDeps(deps)));
  return app;
}

describe('Dashboard API routes', () => {
  describe('GET /api/status', () => {
    it('returns current status', async () => {
      const res = await request(createApp()).get('/api/status');
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('LIVE_RUNNING');
      expect(res.body.generation).toBe(13);
      expect(res.body.healthStatuses).toHaveLength(2);
    });
  });

  describe('POST /api/start', () => {
    it('triggers start and returns 200', async () => {
      const res = await request(createApp()).post('/api/start');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('returns 409 when start fails', async () => {
      const app = createApp({
        triggerStart: jest.fn().mockReturnValue({ ok: false, error: '既に実行中' }),
      });
      const res = await request(app).post('/api/start');
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('実行中');
    });
  });

  describe('POST /api/stop', () => {
    it('triggers stop and returns 200', async () => {
      const res = await request(createApp()).post('/api/stop');
      expect(res.status).toBe(200);
    });

    it('returns 409 when stop fails', async () => {
      const app = createApp({
        triggerStop: jest.fn().mockReturnValue({ ok: false, error: '停止済み' }),
      });
      const res = await request(app).post('/api/stop');
      expect(res.status).toBe(409);
    });
  });

  describe('GET /api/logs', () => {
    it('returns recent action logs', async () => {
      const res = await request(createApp()).get('/api/logs');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].type).toBe('llm_response');
    });
  });

  describe('GET /api/config', () => {
    it('returns current config', async () => {
      const res = await request(createApp()).get('/api/config');
      expect(res.status).toBe(200);
      expect(res.body.operationMode).toBe('MANUAL');
    });
  });

  describe('PUT /api/config', () => {
    it('updates config and returns 200', async () => {
      const res = await request(createApp())
        .put('/api/config')
        .send({ cooldownMinutes: 15 });
      expect(res.status).toBe(200);
    });

    it('returns 400 on empty body', async () => {
      const res = await request(createApp())
        .put('/api/config')
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 400 when update fails', async () => {
      const app = createApp({
        updateConfig: jest.fn().mockReturnValue({ ok: false, error: '無効な値' }),
      });
      const res = await request(app)
        .put('/api/config')
        .send({ cooldownMinutes: -1 });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/history', () => {
    it('returns death history', async () => {
      const res = await request(createApp()).get('/api/history');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].cause).toBe('クリーパー爆発');
    });
  });
});
