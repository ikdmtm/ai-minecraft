import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import { startDashboard } from './server';

jest.mock('express', () => Object.assign(jest.fn(), { json: jest.fn(() => 'json-middleware') }));
jest.mock('./routes', () => ({ createRoutes: jest.fn(() => 'routes') }));

// Verify the public API instead of importing its deliberately private path helper.
describe('dashboard asset resolution through startDashboard', () => {
  const originalCwd = process.cwd();
  let temporaryRoot: string | undefined;
  let handler: (_req: unknown, res: { sendFile: (p: string) => void }) => void;
  let close: jest.Mock;
  beforeEach(() => {
    close = jest.fn();
    (express as unknown as jest.Mock).mockReturnValue({
      use: jest.fn(), get: jest.fn((_route, cb) => { handler = cb; }),
      listen: jest.fn(() => ({ close })),
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.chdir(originalCwd);
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  });
  it('prefers the dashboard asset beside the compiled module', () => {
    const expected = path.join(__dirname, 'index.html');
    const exists = jest.spyOn(fs, 'existsSync').mockImplementation(p => p === expected);
    const server = startDashboard(0, {} as any);
    const sendFile = jest.fn(); handler({}, { sendFile });
    expect(sendFile).toHaveBeenCalledWith(expected);
    expect(exists).toHaveBeenCalledWith(expected);
    server.close(); expect(close).toHaveBeenCalledTimes(1);
  });
  it('falls back to the source asset in development', () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-test-'));
    process.chdir(temporaryRoot);
    const expected = path.join(temporaryRoot, 'src', 'dashboard', 'index.html');
    jest.spyOn(fs, 'existsSync').mockImplementation(p => p === expected);
    startDashboard(0, {} as any);
    const sendFile = jest.fn(); handler({}, { sendFile });
    expect(sendFile).toHaveBeenCalledWith(expected);
  });
  it('reports a missing asset rather than starting a broken server', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(() => startDashboard(0, {} as any)).toThrow('Dashboard HTML not found');
  });
});
