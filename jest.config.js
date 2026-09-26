module.exports = {
  testEnvironment: 'node',
  // Parallel ts-jest workers do not exit cleanly when the CDK and shell smoke
  // suites run together.
  maxWorkers: 1,
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: [
    'ts',
    'mts',
    'cts',
    'tsx',
    'js',
    'mjs',
    'cjs',
    'jsx',
    'json',
    'node',
  ],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
};
