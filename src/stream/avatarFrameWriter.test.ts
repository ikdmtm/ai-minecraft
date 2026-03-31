import { AvatarFrameWriter, type AvatarFrameWriterDeps } from './avatarFrameWriter.js';

interface MockState {
  pipeCreated: boolean;
  pipeRemoved: boolean;
  writtenFrames: Buffer[];
  convertCalls: string[];
  expressionContent: string;
  shouldConvertFail: boolean;
  shouldWriteReturn: boolean;
  drainCallback: (() => void) | null;
}

function createMockDeps(): { deps: AvatarFrameWriterDeps; state: MockState } {
  const state: MockState = {
    pipeCreated: false,
    pipeRemoved: false,
    writtenFrames: [],
    convertCalls: [],
    expressionContent: '',
    shouldConvertFail: false,
    shouldWriteReturn: true,
    drainCallback: null,
  };

  const deps: AvatarFrameWriterDeps = {
    createNamedPipe: () => { state.pipeCreated = true; },
    removeNamedPipe: () => { state.pipeRemoved = true; },
    openPipeStream: () => ({
      write: (buf: Buffer): boolean => {
        state.writtenFrames.push(Buffer.from(buf));
        return state.shouldWriteReturn;
      },
      destroy: () => {},
      destroyed: false,
      on: (event: string, cb: () => void) => {
        if (event === 'drain') state.drainCallback = cb;
      },
    }),
    readExpressionFile: () => state.expressionContent,
    convertImage: (imgPath: string, width: number, height: number) => {
      state.convertCalls.push(imgPath);
      if (state.shouldConvertFail) throw new Error('convert failed');
      return Buffer.alloc(width * height * 4, 0xAA);
    },
    fileExists: () => state.expressionContent !== '',
  };

  return { deps, state };
}

const CONFIG = {
  pipePath: '/tmp/test-avatar.pipe',
  expressionFile: '/tmp/test-expr.txt',
  width: 300,
  height: 400,
  fps: 5,
};

describe('AvatarFrameWriter', () => {
  describe('createPipe', () => {
    it('should create named pipe', () => {
      const { deps, state } = createMockDeps();
      const writer = new AvatarFrameWriter(CONFIG, deps);
      writer.createPipe();
      expect(state.pipeCreated).toBe(true);
    });

    it('should remove existing pipe first', () => {
      const { deps, state } = createMockDeps();
      const writer = new AvatarFrameWriter(CONFIG, deps);
      writer.createPipe();
      expect(state.pipeRemoved).toBe(true);
    });
  });

  describe('connectPipe', () => {
    it('should start writing frames after connect', async () => {
      const { deps, state } = createMockDeps();
      const writer = new AvatarFrameWriter({ ...CONFIG, fps: 20 }, deps);
      writer.createPipe();
      writer.connectPipe();

      await new Promise(r => setTimeout(r, 120));
      writer.stop();

      expect(state.writtenFrames.length).toBeGreaterThan(0);
    });

    it('should write transparent frame when no expression set', async () => {
      const { deps, state } = createMockDeps();
      state.expressionContent = '';
      const writer = new AvatarFrameWriter({ ...CONFIG, fps: 20 }, deps);
      writer.createPipe();
      writer.connectPipe();

      await new Promise(r => setTimeout(r, 80));
      writer.stop();

      const frame = state.writtenFrames[0];
      expect(frame.length).toBe(300 * 400 * 4);
    });
  });

  describe('frame writing', () => {
    it('should convert image and write RGBA frame', () => {
      const { deps, state } = createMockDeps();
      state.expressionContent = '/path/to/happy_open.png';
      const writer = new AvatarFrameWriter(CONFIG, deps);
      writer.createPipe();
      writer.connectPipe();
      writer.writeFrameOnce();
      writer.stop();

      expect(state.convertCalls).toContain('/path/to/happy_open.png');
      expect(state.writtenFrames.length).toBe(1);
      expect(state.writtenFrames[0].length).toBe(300 * 400 * 4);
    });

    it('should cache frame and not re-convert same image', () => {
      const { deps, state } = createMockDeps();
      state.expressionContent = '/path/to/normal_closed.png';
      const writer = new AvatarFrameWriter(CONFIG, deps);
      writer.createPipe();
      writer.connectPipe();
      writer.writeFrameOnce();
      writer.writeFrameOnce();
      writer.stop();

      expect(state.convertCalls.length).toBe(1);
      expect(state.writtenFrames.length).toBe(2);
    });

    it('should re-convert when expression changes', () => {
      const { deps, state } = createMockDeps();
      state.expressionContent = '/path/to/normal_closed.png';
      const writer = new AvatarFrameWriter(CONFIG, deps);
      writer.createPipe();
      writer.connectPipe();
      writer.writeFrameOnce();

      state.expressionContent = '/path/to/happy_open.png';
      writer.writeFrameOnce();
      writer.stop();

      expect(state.convertCalls.length).toBe(2);
    });

    it('should use cached frame when convert fails', () => {
      const { deps, state } = createMockDeps();
      state.expressionContent = '/path/to/normal_closed.png';
      const writer = new AvatarFrameWriter(CONFIG, deps);
      writer.createPipe();
      writer.connectPipe();
      writer.writeFrameOnce();

      state.expressionContent = '/path/to/broken.png';
      state.shouldConvertFail = true;
      writer.writeFrameOnce();
      writer.stop();

      expect(state.writtenFrames.length).toBe(2);
      expect(state.writtenFrames[0]).toEqual(state.writtenFrames[1]);
    });

    it('should handle backpressure by skipping frames', () => {
      const { deps, state } = createMockDeps();
      state.shouldWriteReturn = false;
      state.expressionContent = '/path/to/normal_closed.png';
      const writer = new AvatarFrameWriter(CONFIG, deps);
      writer.createPipe();
      writer.connectPipe();
      writer.writeFrameOnce();
      writer.writeFrameOnce();
      writer.stop();

      expect(state.writtenFrames.length).toBe(1);
    });
  });

  describe('stop', () => {
    it('should clean up on stop', () => {
      const { deps, state } = createMockDeps();
      const writer = new AvatarFrameWriter(CONFIG, deps);
      writer.createPipe();
      state.pipeRemoved = false;
      writer.connectPipe();
      writer.stop();

      expect(state.pipeRemoved).toBe(true);
    });

    it('should be idempotent', () => {
      const { deps } = createMockDeps();
      const writer = new AvatarFrameWriter(CONFIG, deps);
      writer.createPipe();
      writer.connectPipe();
      writer.stop();
      writer.stop();
    });
  });
});
