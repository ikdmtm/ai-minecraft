import express from 'express';
import fs from 'fs';
import path from 'path';
import { createRoutes, type DashboardDeps } from './routes.js';

export function resolveDashboardHtmlPath(): string {
  const candidates = [
    path.join(__dirname, 'index.html'),
    path.join(process.cwd(), 'src', 'dashboard', 'index.html'),
    path.join(process.cwd(), 'dist', 'dashboard', 'index.html'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Dashboard HTML not found. looked in: ${candidates.join(', ')}`);
}

/**
 * ダッシュボード HTTP サーバーを起動する。
 * オーケストレーター内で呼び出し、DI で各種依存を注入する。
 */
export function startDashboard(port: number, deps: DashboardDeps): { close: () => void } {
  const app = express();
  const dashboardHtmlPath = resolveDashboardHtmlPath();

  app.use(express.json());
  app.use(createRoutes(deps));

  app.get('/', (_req, res) => {
    res.sendFile(dashboardHtmlPath);
  });

  const server = app.listen(port);

  return {
    close: () => server.close(),
  };
}
