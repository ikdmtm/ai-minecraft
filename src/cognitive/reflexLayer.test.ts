import { isDeathMessage } from './reflexLayer';

describe('isDeathMessage', () => {
  it('detects "was slain by" message', () => {
    expect(isDeathMessage('AI_Rei was slain by Zombie')).toBe(true);
  });

  it('detects "was shot by" message', () => {
    expect(isDeathMessage('AI_Rei was shot by Skeleton')).toBe(true);
  });

  it('detects "was blown up by" message', () => {
    expect(isDeathMessage('AI_Rei was blown up by Creeper')).toBe(true);
  });

  it('detects drowning', () => {
    expect(isDeathMessage('AI_Rei drowned')).toBe(true);
  });

  it('detects burning', () => {
    expect(isDeathMessage('AI_Rei burned to death')).toBe(true);
  });

  it('detects fall damage', () => {
    expect(isDeathMessage('AI_Rei hit the ground too hard')).toBe(true);
  });

  it('detects lava', () => {
    expect(isDeathMessage('AI_Rei tried to swim in lava')).toBe(true);
  });

  it('detects starvation', () => {
    expect(isDeathMessage('AI_Rei starved to death')).toBe(true);
  });

  it('detects suffocation', () => {
    expect(isDeathMessage('AI_Rei suffocated in a wall')).toBe(true);
  });

  it('detects generic died message', () => {
    expect(isDeathMessage('AI_Rei died')).toBe(true);
  });

  it('does not match normal chat messages', () => {
    expect(isDeathMessage('Hello world')).toBe(false);
  });

  it('does not match join messages', () => {
    expect(isDeathMessage('AI_Rei joined the game')).toBe(false);
  });

  it('is case insensitive', () => {
    expect(isDeathMessage('AI_Rei Was Slain By Zombie')).toBe(true);
  });
});
