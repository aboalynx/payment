// Plain JS, not TypeScript: a jest.config.ts requires ts-node to parse. Node 24
// strips types natively so a .ts config appears to work locally, but Node 20 cannot,
// and CI runs both. JSDoc keeps the type checking without the dependency.

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.spec\\.ts$',
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  coverageThreshold: {
    global: { branches: 80, functions: 90, lines: 90, statements: 90 },
  },
};
