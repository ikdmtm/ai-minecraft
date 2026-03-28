import express from 'express';
import path from 'path';
import { createRoutes, type DashboardDeps } from './routes.js';

/**
 * ダッシュボード HTTP サーバーを起動する。
 * オーケストレーター内で呼び出し、DI で各種依存を注入する。
 */
export function startDashboard(port: number, deps: DashboardDeps): { close: () => void } {
  const app = express();

  app.use(express.json());
  app.use(createRoutes(deps));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(import.meta.dirname ?? __dirname, 'index.html'));
  });

  const server = app.listen(port);

  return {
    close: () => server.close(),
  };
}
