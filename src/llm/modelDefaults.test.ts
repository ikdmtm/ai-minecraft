import {
  DEFAULT_FAREWELL_MODEL,
  DEFAULT_STRATEGIC_MODEL,
  DEFAULT_TACTICAL_MODEL,
} from './modelDefaults';

describe('Anthropic model defaults', () => {
  it('uses a currently supported Haiku model for tactical commentary', () => {
    expect(DEFAULT_TACTICAL_MODEL).toBe('claude-haiku-4-5-20251001');
  });

  it('reuses the tactical default for death farewell generation', () => {
    expect(DEFAULT_FAREWELL_MODEL).toBe(DEFAULT_TACTICAL_MODEL);
  });

  it('keeps the strategic default on Sonnet 4', () => {
    expect(DEFAULT_STRATEGIC_MODEL).toBe('claude-sonnet-4-6');
  });
});
