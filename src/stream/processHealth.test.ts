import { EventEmitter } from 'events';
import { waitForProcessStability, type StableProcess } from './processHealth';

class MockStableProcess extends EventEmitter implements StableProcess {
  exitCode: number | null = null;
}

describe('waitForProcessStability', () => {
  it('resolves when the process stays alive through the grace period', async () => {
    const proc = new MockStableProcess();

    await expect(waitForProcessStability(proc, 20)).resolves.toBeUndefined();
  });

  it('rejects when the process exits during the grace period', async () => {
    const proc = new MockStableProcess();
    const promise = waitForProcessStability(proc, 50);

    setTimeout(() => {
      proc.exitCode = 1;
      proc.emit('exit', 1, null);
    }, 10);

    await expect(promise).rejects.toThrow('ffmpeg exited before the stream became stable');
  });

  it('rejects immediately when the process is already exited', async () => {
    const proc = new MockStableProcess();
    proc.exitCode = 1;

    await expect(waitForProcessStability(proc, 20)).rejects.toThrow(
      'ffmpeg exited before the stream became stable',
    );
  });
});
