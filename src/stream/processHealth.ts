import type { EventEmitter } from 'events';

export interface StableProcess extends EventEmitter {
  exitCode: number | null;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export function waitForProcessStability(
  process: StableProcess,
  stableMs: number,
  label = 'ffmpeg',
): Promise<void> {
  if (process.exitCode !== null) {
    return Promise.reject(new Error(`${label} exited before the stream became stable`));
  }

  return new Promise<void>((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      reject(new Error(`${label} exited before the stream became stable`));
    };

    const timer = setTimeout(() => {
      process.removeListener('exit', onExit);
      resolve();
    }, stableMs);

    process.once('exit', onExit);
  });
}
