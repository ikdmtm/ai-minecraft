import { CommentarySubtitleSync } from './commentarySubtitleSync';

describe('CommentarySubtitleSync', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows subtitles after the configured playback delay', () => {
    jest.useFakeTimers();
    const update = jest.fn();
    const sync = new CommentarySubtitleSync(update, { displayDelayMs: 220 });

    sync.onPlaybackStart('字幕テキスト');

    expect(update).not.toHaveBeenCalled();
    jest.advanceTimersByTime(219);
    expect(update).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(update).toHaveBeenCalledWith('字幕テキスト');
  });

  it('clears subtitles when playback ends', () => {
    jest.useFakeTimers();
    const update = jest.fn();
    const sync = new CommentarySubtitleSync(update, { displayDelayMs: 220 });

    sync.onPlaybackStart('字幕テキスト');
    jest.advanceTimersByTime(220);
    sync.onPlaybackEnd();

    expect(update).toHaveBeenNthCalledWith(1, '字幕テキスト');
    expect(update).toHaveBeenNthCalledWith(2, '');
  });

  it('cancels a delayed subtitle when playback ends before the delay elapses', () => {
    jest.useFakeTimers();
    const update = jest.fn();
    const sync = new CommentarySubtitleSync(update, { displayDelayMs: 220 });

    sync.onPlaybackStart('短い字幕');
    jest.advanceTimersByTime(100);
    sync.onPlaybackEnd();
    jest.advanceTimersByTime(200);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('');
  });

  it('replaces the visible subtitle when the next playback starts', () => {
    jest.useFakeTimers();
    const update = jest.fn();
    const sync = new CommentarySubtitleSync(update, { displayDelayMs: 50 });

    sync.onPlaybackStart('ひとつめ');
    jest.advanceTimersByTime(50);
    sync.onPlaybackEnd();
    sync.onPlaybackStart('ふたつめ');
    jest.advanceTimersByTime(50);

    expect(update).toHaveBeenNthCalledWith(1, 'ひとつめ');
    expect(update).toHaveBeenNthCalledWith(2, '');
    expect(update).toHaveBeenNthCalledWith(3, 'ふたつめ');
  });
});
