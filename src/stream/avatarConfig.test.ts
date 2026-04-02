import fs from 'fs';
import path from 'path';
import { resolveAvatarBasePath } from './avatarConfig';

describe('resolveAvatarBasePath', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prefers an explicit environment override when it exists', () => {
    const override = '/tmp/custom-avatar';
    jest.spyOn(fs, 'existsSync').mockImplementation((candidate) => {
      return candidate === override
        || candidate === path.join(override, 'normal_closed.png')
        || candidate === path.join(override, 'normal_open.png');
    });

    expect(resolveAvatarBasePath(override)).toBe(override);
  });

  it('defaults to the processed production avatar assets', () => {
    const processed = path.join(process.cwd(), 'assets', 'avatar', 'processed');
    jest.spyOn(fs, 'existsSync').mockImplementation((candidate) => {
      return candidate === processed
        || candidate === path.join(processed, 'normal_closed.png')
        || candidate === path.join(processed, 'normal_open.png');
    });

    expect(resolveAvatarBasePath()).toBe(processed);
  });

  it('falls back to the original assets when processed assets are missing', () => {
    const original = path.join(process.cwd(), 'assets', 'avatar', 'original');
    jest.spyOn(fs, 'existsSync').mockImplementation((candidate) => {
      return candidate === original
        || candidate === path.join(original, 'normal_closed.png')
        || candidate === path.join(original, 'normal_open.png');
    });

    expect(resolveAvatarBasePath()).toBe(original);
  });

  it('falls back to the legacy avatar directory if original assets are missing', () => {
    const legacy = path.join(process.cwd(), 'assets', 'avatar');
    jest.spyOn(fs, 'existsSync').mockImplementation((candidate) => {
      return candidate === legacy
        || candidate === path.join(legacy, 'normal_closed.png')
        || candidate === path.join(legacy, 'normal_open.png');
    });

    expect(resolveAvatarBasePath()).toBe(legacy);
  });
});
