import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('one-touch Bash launcher integration and fail-closed boundaries', () => {
  const result = spawnSync('python3', ['scripts/test-one-touch.py'], {
    cwd: resolve(__dirname, '../..'), encoding: 'utf8', timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`one_touch_tests_failed: ${result.error?.message ?? result.status}\n${result.stdout}\n${result.stderr}`);
  }
  expect(result.status).toBe(0);
}, 65000);
