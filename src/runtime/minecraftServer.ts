export function buildServerReadyJournalCommand(sinceMs: number): string {
  const sinceSeconds = Math.floor(sinceMs / 1000);
  return `sudo journalctl -u minecraft-server --no-pager --since "@${sinceSeconds}"`;
}

export function isServerReadyLog(output: string): boolean {
  return output.includes('Done (') || output.includes('For help, type "help"');
}

export interface WaitForMinecraftServerReadyOptions {
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readLogsSince: (sinceMs: number) => string;
}

export async function waitForMinecraftServerReady(
  options: WaitForMinecraftServerReadyOptions,
): Promise<boolean> {
  const startedAt = (options.now ?? Date.now)();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 3000;

  while (now() - startedAt <= options.timeoutMs) {
    try {
      const output = options.readLogsSince(startedAt);
      if (isServerReadyLog(output)) {
        return true;
      }
    } catch {
      // service restart timing can briefly break journalctl; retry until timeout
    }

    await sleep(pollMs);
  }

  return false;
}
