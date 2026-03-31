/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // WSL 等でメモリが限られると複数ワーカーが SIGKILL されるため既定を抑える
  maxWorkers: process.env.JEST_MAX_WORKERS
    ? parseInt(process.env.JEST_MAX_WORKERS, 10)
    : 1,
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: { module: 'commonjs', moduleResolution: 'node' },
      diagnostics: { ignoreCodes: [151002] },
    }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/types/**',
    '!src/index.ts',
  ],
};
