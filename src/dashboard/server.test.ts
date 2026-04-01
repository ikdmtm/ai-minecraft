import fs from 'fs';
import path from 'path';

describe('resolveDashboardHtmlPath', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    jest.restoreAllMocks();
    process.chdir(originalCwd);
  });

  it('prefers the compiled dashboard asset when it exists', async () => {
    const modulePath = './server';
    const existsSync = jest.spyOn(fs, 'existsSync').mockImplementation((candidate) => {
      return candidate === path.join(__dirname, 'index.html');
    });

    const { resolveDashboardHtmlPath } = await import(modulePath);

    expect(resolveDashboardHtmlPath()).toBe(path.join(__dirname, 'index.html'));
    expect(existsSync).toHaveBeenCalledWith(path.join(__dirname, 'index.html'));
  });

  it('falls back to the source dashboard asset in development', async () => {
    const projectRoot = fs.mkdtempSync(path.join(process.cwd(), 'tmp-dashboard-test-'));
    process.chdir(projectRoot);

    const expected = path.join(projectRoot, 'src', 'dashboard', 'index.html');
    jest.spyOn(fs, 'existsSync').mockImplementation((candidate) => candidate === expected);

    const { resolveDashboardHtmlPath } = await import('./server');

    expect(resolveDashboardHtmlPath()).toBe(expected);
  });
});
