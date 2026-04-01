import { ReflexLayer } from './reflexLayer';
import { SharedStateBus } from './sharedState';

describe('ReflexLayer mining guard', () => {
  it('ignores null or positionless candidates passed to findBlock matcher', async () => {
    const layer = new ReflexLayer(new SharedStateBus());
    const doExploreSpy = jest.spyOn(layer as any, 'doExplore').mockResolvedValue(undefined);

    const findBlock = jest.fn(({ matching }: { matching: (block: unknown) => boolean }) => {
      expect(matching(null)).toBe(false);
      expect(matching({ name: 'oak_log' })).toBe(false);
      return null;
    });

    (layer as any).bot = { findBlock };

    await (layer as any).doMineBlock(['oak_log']);

    expect(findBlock).toHaveBeenCalledTimes(1);
    expect(doExploreSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to explore when findBlock returns a block without position', async () => {
    const shared = new SharedStateBus();
    const layer = new ReflexLayer(shared);
    const doExploreSpy = jest.spyOn(layer as any, 'doExplore').mockResolvedValue(undefined);

    const malformedBlock = { name: 'oak_log', position: null };
    (layer as any).bot = {
      findBlock: jest.fn(() => malformedBlock),
    };

    await (layer as any).doMineBlock(['oak_log']);

    expect(doExploreSpy).toHaveBeenCalledTimes(1);
    expect(shared.get().worldModel.resourceLocations).toHaveLength(0);
  });
});
