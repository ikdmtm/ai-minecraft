import {
  buildServerReadyJournalCommand,
  isServerReadyLog,
} from './minecraftServer';

describe('minecraftServer helpers', () => {
  it('builds a journalctl command without a line-count cap', () => {
    const command = buildServerReadyJournalCommand(1_711_111_111_000);

    expect(command).toContain('journalctl -u minecraft-server');
    expect(command).toContain('--since "@1711111111"');
    expect(command).not.toContain(' -n ');
  });

  it('detects the dedicated server done marker', () => {
    const output = '[12:14:22] [Server thread/INFO]: Done (37.344s)! For help, type "help"';
    expect(isServerReadyLog(output)).toBe(true);
  });

  it('detects the help marker even if Done is absent', () => {
    const output = '[12:14:22] [Server thread/INFO]: For help, type "help"';
    expect(isServerReadyLog(output)).toBe(true);
  });

  it('does not report ready for unrelated log lines', () => {
    const output = '[12:14:20] [Server thread/INFO]: Preparing spawn area: 45%';
    expect(isServerReadyLog(output)).toBe(false);
  });
});
