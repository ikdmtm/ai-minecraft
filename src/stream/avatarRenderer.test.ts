import { AvatarRenderer, EXPRESSION_FILE } from './avatarRenderer';
import { AvatarState } from './avatar';

describe('AvatarRenderer', () => {
  let avatarState: AvatarState;
  let renderer: AvatarRenderer;
  let writtenExpressions: Array<{ path: string; value: string }>;

  const mockDeps = {
    writeExpression: (filePath: string, expression: string) => {
      writtenExpressions.push({ path: filePath, value: expression });
    },
  };

  beforeEach(() => {
    avatarState = new AvatarState();
    writtenExpressions = [];
    renderer = new AvatarRenderer(avatarState, '/assets/avatar', mockDeps);
  });

  afterEach(() => {
    renderer.stop();
    avatarState.destroy();
  });

  it('writes initial expression on start', () => {
    renderer.start();
    expect(writtenExpressions).toHaveLength(1);
    expect(writtenExpressions[0]).toEqual({
      path: EXPRESSION_FILE,
      value: '/assets/avatar/normal_closed.png',
    });
  });

  it('writes new expression when threat level changes', () => {
    renderer.start();
    writtenExpressions = [];

    avatarState.update({ threatLevel: 'high', isSpeaking: false });
    renderer.stop();
    renderer.start();

    expect(writtenExpressions[0]).toEqual({
      path: EXPRESSION_FILE,
      value: '/assets/avatar/sad_closed.png',
    });
  });

  it('skips write when expression has not changed', () => {
    renderer.start();
    writtenExpressions = [];

    renderer.stop();
    renderer.start();

    expect(writtenExpressions).toHaveLength(0);
  });

  it('toggles mouth state via tick on timer', async () => {
    avatarState.update({ threatLevel: 'low', isSpeaking: true });
    renderer.start();
    writtenExpressions = [];

    // 5fps = 200ms interval, wait for at least 3 ticks
    await sleep(650);

    const openWrites = writtenExpressions.filter((w) =>
      w.value.includes('_open.png'),
    );
    const closedWrites = writtenExpressions.filter((w) =>
      w.value.includes('_closed.png'),
    );

    expect(openWrites.length).toBeGreaterThan(0);
    expect(closedWrites.length).toBeGreaterThan(0);
  });

  it('updates expression when special expression triggers', () => {
    renderer.start();
    writtenExpressions = [];

    avatarState.triggerSpecial('happy');
    renderer.stop();
    renderer.start();

    expect(writtenExpressions[0]?.value).toContain('happy_closed.png');
  });

  it('stops timer on stop()', () => {
    renderer.start();
    expect(renderer.isRunning()).toBe(true);
    renderer.stop();
    expect(renderer.isRunning()).toBe(false);
  });

  it('handles write failure gracefully', () => {
    const failDeps = {
      writeExpression: () => {
        throw new Error('disk full');
      },
    };
    const failRenderer = new AvatarRenderer(avatarState, '/assets', failDeps);
    expect(() => failRenderer.start()).not.toThrow();
    failRenderer.stop();
  });

  it('getCurrentExpression returns last written key', () => {
    renderer.start();
    expect(renderer.getCurrentExpression()).toBe('normal_closed');
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
