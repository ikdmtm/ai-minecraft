import { Router } from 'express';
import type { HealthStatus } from '../health/checker.js';
import type { Result } from '../types/result.js';

export interface DashboardLogEntry {
  timestamp: string;
  type: string;
  content: string;
}

export interface StatusResponse {
  state: string;
  generation: number;
  survivalMinutes: number;
  bestRecordMinutes: number;
  operationMode: string;
  dailyStreamCount: number;
  healthStatuses: HealthStatus[];
}

export interface DashboardDeps {
  getStatus: () => StatusResponse;
  triggerStart: () => Result<void>;
  triggerStop: () => Result<void>;
  getLogs: () => DashboardLogEntry[];
  getConfig: () => Record<string, unknown>;
  updateConfig: (partial: Record<string, unknown>) => Result<void>;
  getDeathHistory: () => unknown[];
}

export function createRoutes(deps: DashboardDeps): Router {
  const router = Router();

  router.get('/api/status', (_req, res) => {
    res.json(deps.getStatus());
  });

  router.post('/api/start', (_req, res) => {
    const result = deps.triggerStart();
    if (result.ok) {
      res.json({ ok: true });
    } else {
      res.status(409).json({ ok: false, error: result.error });
    }
  });

  router.post('/api/stop', (_req, res) => {
    const result = deps.triggerStop();
    if (result.ok) {
      res.json({ ok: true });
    } else {
      res.status(409).json({ ok: false, error: result.error });
    }
  });

  router.get('/api/logs', (_req, res) => {
    res.json(deps.getLogs());
  });

  router.get('/api/config', (_req, res) => {
    res.json(deps.getConfig());
  });

  router.put('/api/config', (req, res) => {
    const body = req.body;
    if (!body || Object.keys(body).length === 0) {
      res.status(400).json({ ok: false, error: '更新内容が空です' });
      return;
    }
    const result = deps.updateConfig(body);
    if (result.ok) {
      res.json({ ok: true });
    } else {
      res.status(400).json({ ok: false, error: result.error });
    }
  });

  router.get('/api/history', (_req, res) => {
    res.json(deps.getDeathHistory());
  });

  return router;
}
