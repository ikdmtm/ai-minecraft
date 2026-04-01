import { CommentaryThrottle } from './commentaryThrottle';

describe('CommentaryThrottle', () => {
  it('allows the first commentary immediately', () => {
    const throttle = new CommentaryThrottle({ minIntervalMs: 12_000 });

    expect(throttle.decide(0, 1_000)).toBe('enqueue');
  });

  it('skips commentary during the cooldown window', () => {
    const throttle = new CommentaryThrottle({ minIntervalMs: 12_000 });

    expect(throttle.decide(0, 1_000)).toBe('enqueue');
    expect(throttle.decide(0, 5_000)).toBe('skip');
  });

  it('replaces the pending commentary when enough time has passed and audio is still playing', () => {
    const throttle = new CommentaryThrottle({ minIntervalMs: 12_000 });

    expect(throttle.decide(0, 1_000)).toBe('enqueue');
    expect(throttle.decide(1, 13_500)).toBe('replace');
  });

  it('resets the cooldown between streaming sessions', () => {
    const throttle = new CommentaryThrottle({ minIntervalMs: 12_000 });

    expect(throttle.decide(0, 1_000)).toBe('enqueue');
    expect(throttle.decide(0, 5_000)).toBe('skip');

    throttle.reset();

    expect(throttle.decide(0, 6_000)).toBe('enqueue');
  });
});
