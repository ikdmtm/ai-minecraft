import { AvatarState, type AvatarExpression } from './avatar';

describe('AvatarState', () => {
  let avatar: AvatarState;

  beforeEach(() => {
    avatar = new AvatarState();
  });

  afterEach(() => {
    avatar.destroy();
  });

  describe('expression from threat level', () => {
    it('returns normal for low threat', () => {
      avatar.update({ threatLevel: 'low', isSpeaking: false });
      expect(avatar.getExpression()).toBe('normal');
    });

    it('returns serious for medium threat', () => {
      avatar.update({ threatLevel: 'medium', isSpeaking: false });
      expect(avatar.getExpression()).toBe('serious');
    });

    it('returns anxious for high threat', () => {
      avatar.update({ threatLevel: 'high', isSpeaking: false });
      expect(avatar.getExpression()).toBe('anxious');
    });

    it('returns scared for critical threat', () => {
      avatar.update({ threatLevel: 'critical', isSpeaking: false });
      expect(avatar.getExpression()).toBe('scared');
    });
  });

  describe('special expressions', () => {
    it('returns happy on record event', () => {
      avatar.triggerSpecial('happy');
      expect(avatar.getExpression()).toBe('happy');
    });

    it('returns thinking when LLM is processing', () => {
      avatar.triggerSpecial('thinking');
      expect(avatar.getExpression()).toBe('thinking');
    });

    it('special expression expires after duration', () => {
      avatar.triggerSpecial('happy', 50);
      expect(avatar.getExpression()).toBe('happy');

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(avatar.getExpression()).not.toBe('happy');
          resolve();
        }, 100);
      });
    });

    it('special expression overrides threat level', () => {
      avatar.update({ threatLevel: 'critical', isSpeaking: false });
      avatar.triggerSpecial('happy');
      expect(avatar.getExpression()).toBe('happy');
    });
  });

  describe('mouth state (lip sync)', () => {
    it('mouth is closed when not speaking', () => {
      avatar.update({ threatLevel: 'low', isSpeaking: false });
      expect(avatar.isMouthOpen()).toBe(false);
    });

    it('mouth toggles when speaking', () => {
      avatar.update({ threatLevel: 'low', isSpeaking: true });
      // Mouth state alternates on tick
      const states: boolean[] = [];
      for (let i = 0; i < 4; i++) {
        avatar.tick();
        states.push(avatar.isMouthOpen());
      }
      // Should alternate: open, closed, open, closed
      expect(states).toEqual([true, false, true, false]);
    });

    it('mouth closes when speech stops', () => {
      avatar.update({ threatLevel: 'low', isSpeaking: true });
      avatar.tick();
      expect(avatar.isMouthOpen()).toBe(true);

      avatar.update({ threatLevel: 'low', isSpeaking: false });
      expect(avatar.isMouthOpen()).toBe(false);
    });
  });

  describe('image file path', () => {
    it('returns correct path for normal + mouth closed', () => {
      avatar.update({ threatLevel: 'low', isSpeaking: false });
      expect(avatar.getImagePath('assets/avatar')).toBe('assets/avatar/normal_closed.png');
    });

    it('returns correct path for scared + mouth open', () => {
      avatar.update({ threatLevel: 'critical', isSpeaking: true });
      avatar.tick();
      expect(avatar.getImagePath('assets/avatar')).toBe('assets/avatar/scared_open.png');
    });

    it('returns correct path for happy + mouth closed', () => {
      avatar.triggerSpecial('happy');
      expect(avatar.getImagePath('assets/avatar')).toBe('assets/avatar/happy_closed.png');
    });
  });
});
