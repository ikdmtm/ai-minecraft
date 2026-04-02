import { AvatarState, type AvatarExpression } from './avatar';

describe('AvatarState', () => {
  let avatar: AvatarState;

  beforeEach(() => {
    avatar = new AvatarState();
  });

  afterEach(() => {
    avatar.destroy();
    jest.useRealTimers();
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

    it('returns sad for high threat', () => {
      avatar.update({ threatLevel: 'high', isSpeaking: false });
      expect(avatar.getExpression()).toBe('sad');
    });

    it('returns surprised for critical threat', () => {
      avatar.update({ threatLevel: 'critical', isSpeaking: false });
      expect(avatar.getExpression()).toBe('surprised');
    });
  });

  describe('expression from emotion', () => {
    it('uses happy when the bot is emotionally positive', () => {
      avatar.update({ threatLevel: 'low', emotionLabel: 'excited', isSpeaking: false });
      expect(avatar.getExpression()).toBe('happy');
    });

    it('uses serious when the bot is anxious', () => {
      avatar.update({ threatLevel: 'low', emotionLabel: 'anxious', isSpeaking: false });
      expect(avatar.getExpression()).toBe('serious');
    });

    it('keeps danger-first expression on high threat even if emotion is positive', () => {
      avatar.update({ threatLevel: 'high', emotionLabel: 'excited', isSpeaking: false });
      expect(avatar.getExpression()).toBe('sad');
    });

    it('does not rapidly flip expressions for small emotional changes', () => {
      jest.useFakeTimers();
      let now = 1_000;
      avatar = new AvatarState({ now: () => now, expressionHoldMs: 1_500 });

      avatar.update({ threatLevel: 'low', emotionLabel: 'excited', isSpeaking: false });
      expect(avatar.getExpression()).toBe('happy');

      now = 1_400;
      avatar.update({ threatLevel: 'low', emotionLabel: 'neutral', isSpeaking: false });
      expect(avatar.getExpression()).toBe('happy');

      now = 2_600;
      avatar.update({ threatLevel: 'low', emotionLabel: 'neutral', isSpeaking: false });
      expect(avatar.getExpression()).toBe('normal');
    });

    it('still switches immediately on urgent threat changes', () => {
      let now = 1_000;
      avatar = new AvatarState({ now: () => now, expressionHoldMs: 5_000 });

      avatar.update({ threatLevel: 'low', emotionLabel: 'content', isSpeaking: false });
      expect(avatar.getExpression()).toBe('happy');

      now = 1_100;
      avatar.update({ threatLevel: 'critical', emotionLabel: 'content', isSpeaking: true });
      expect(avatar.getExpression()).toBe('surprised');
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

    it('keeps the mouth closed for emotional expressions even while speaking', () => {
      avatar.update({ threatLevel: 'low', emotionLabel: 'excited', isSpeaking: true });
      avatar.tick();

      expect(avatar.isMouthOpen()).toBe(false);
      expect(avatar.getImagePath('assets/avatar')).toBe('assets/avatar/happy_closed.png');
    });
  });

  describe('image file path', () => {
    it('returns correct path for normal + mouth closed', () => {
      avatar.update({ threatLevel: 'low', isSpeaking: false });
      expect(avatar.getImagePath('assets/avatar')).toBe('assets/avatar/normal_closed.png');
    });

    it('returns closed-mouth path for surprised even while speaking', () => {
      avatar.update({ threatLevel: 'critical', isSpeaking: true });
      avatar.tick();
      expect(avatar.getImagePath('assets/avatar')).toBe('assets/avatar/surprised_closed.png');
    });

    it('returns correct path for happy + mouth closed', () => {
      avatar.triggerSpecial('happy');
      expect(avatar.getImagePath('assets/avatar')).toBe('assets/avatar/happy_closed.png');
    });
  });
});
