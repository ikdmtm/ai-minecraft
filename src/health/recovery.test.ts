import { RecoveryDispatcher, type RecoveryAction, type CommandExecutor } from './recovery';

describe('RecoveryDispatcher', () => {
  let executor: jest.Mocked<CommandExecutor>;
  let dispatcher: RecoveryDispatcher;

  const ACTIONS: RecoveryAction[] = [
    { targetName: 'minecraft-server', command: 'systemctl restart minecraft-server' },
    { targetName: 'voicevox', command: 'docker restart voicevox' },
    { targetName: 'orchestrator', command: 'systemctl restart orchestrator.service' },
  ];

  beforeEach(() => {
    executor = { exec: jest.fn().mockResolvedValue({ success: true, output: '' }) };
    dispatcher = new RecoveryDispatcher(ACTIONS, executor);
  });

  it('executes matching recovery command', async () => {
    const result = await dispatcher.recover('minecraft-server');
    expect(result.ok).toBe(true);
    expect(executor.exec).toHaveBeenCalledWith('systemctl restart minecraft-server');
  });

  it('returns error for unknown target', async () => {
    const result = await dispatcher.recover('unknown-service');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown-service');
  });

  it('returns error when command fails', async () => {
    executor.exec.mockResolvedValue({ success: false, output: 'unit not found' });
    const result = await dispatcher.recover('minecraft-server');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unit not found');
  });

  it('returns error when executor throws', async () => {
    executor.exec.mockRejectedValue(new Error('permission denied'));
    const result = await dispatcher.recover('voicevox');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('permission denied');
  });

  it('prevents rapid-fire recovery for same target', async () => {
    await dispatcher.recover('voicevox');
    const second = await dispatcher.recover('voicevox');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain('クールダウン');
    expect(executor.exec).toHaveBeenCalledTimes(1);
  });

  it('allows recovery after cooldown expires', async () => {
    dispatcher = new RecoveryDispatcher(ACTIONS, executor, { cooldownMs: 50 });
    await dispatcher.recover('voicevox');
    await new Promise((r) => setTimeout(r, 100));
    const second = await dispatcher.recover('voicevox');
    expect(second.ok).toBe(true);
    expect(executor.exec).toHaveBeenCalledTimes(2);
  });

  it('tracks different targets independently', async () => {
    await dispatcher.recover('minecraft-server');
    const result = await dispatcher.recover('voicevox');
    expect(result.ok).toBe(true);
    expect(executor.exec).toHaveBeenCalledTimes(2);
  });

  it('logs recovery attempts', async () => {
    const log = jest.fn();
    dispatcher = new RecoveryDispatcher(ACTIONS, executor, { onRecoveryAttempt: log });
    await dispatcher.recover('voicevox');
    expect(log).toHaveBeenCalledWith('voicevox', 'docker restart voicevox', true);
  });

  it('logs failed recovery attempts', async () => {
    const log = jest.fn();
    executor.exec.mockResolvedValue({ success: false, output: 'fail' });
    dispatcher = new RecoveryDispatcher(ACTIONS, executor, { onRecoveryAttempt: log });
    await dispatcher.recover('voicevox');
    expect(log).toHaveBeenCalledWith('voicevox', 'docker restart voicevox', false);
  });
});
