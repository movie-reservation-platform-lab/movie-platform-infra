module.exports = {
  testEnvironment: 'node',
  // Parallel ts-jest workers do not exit cleanly when the CDK and shell smoke
  // suites run together.
  maxWorkers: 1,
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
};
