import { PreflightFailure } from '../../aws-account-preflight/src';
import { runCli, type CliDependencies } from '../src';
import {
  FOUNDATION_STACK,
  REPOSITORY,
  TEST_ARTIFACT_REPOSITORY_CATALOG,
  TEST_ACCESS,
  TEST_DIGEST_A,
  TEST_TARGET,
  createReader,
} from './test-support';

interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const status = await runCli(
    arguments_,
    {},
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    dependencies,
  );
  return { status, stdout, stderr };
}

function successfulDependencies(events: string[] = []): CliDependencies {
  return {
    validateAccess: () => {
      events.push('preflight');
      return TEST_ACCESS;
    },
    createReader: (access) => {
      events.push(
        `clients:${access.target.profile}:${access.target.region}:` +
          `${access.configFiles.configFilepath}:${access.configFiles.credentialsFilepath}`,
      );
      const reader = createReader({
        foundationStack: FOUNDATION_STACK,
        repositories: [REPOSITORY],
      });
      return {
        verifyIdentity: async () => {
          events.push('identity');
          return reader.verifyIdentity();
        },
        inspectStack: async (stackName) => {
          events.push(`stack:${stackName}`);
          return reader.inspectStack(stackName);
        },
        inspectRepository: async (definition) => {
          events.push(`repository:${definition.componentId}`);
          return reader.inspectRepository(definition);
        },
      };
    },
    artifactRepositoryCatalog: TEST_ARTIFACT_REPOSITORY_CATALOG,
  };
}

test.each([['--help'], ['-h']])('prints help without target access for %s', async (argument) => {
  const validateAccess = jest.fn(() => TEST_ACCESS);
  const createReaderMock = jest.fn(() => createReader({}));

  const result = await run([argument], {
    validateAccess,
    createReader: createReaderMock,
    artifactRepositoryCatalog: TEST_ARTIFACT_REPOSITORY_CATALOG,
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('npm run inspect:artifact-foundation -- [--help]');
  expect(result.stdout).toContain('Checks whether final project cleanup can proceed');
  expect(result.stdout).toContain('MovieReservationWorkloadStack');
  expect(result.stdout).toContain('there is no --execute option');
  expect(validateAccess).not.toHaveBeenCalled();
  expect(createReaderMock).not.toHaveBeenCalled();
});

test('rejects a future execute option before preflight or client creation', async () => {
  const validateAccess = jest.fn(() => TEST_ACCESS);
  const createReaderMock = jest.fn(() => createReader({}));

  const result = await run(['--execute'], {
    validateAccess,
    createReader: createReaderMock,
    artifactRepositoryCatalog: TEST_ARTIFACT_REPOSITORY_CATALOG,
  });

  expect(result).toEqual({
    status: 1,
    stdout: '',
    stderr:
      'Artifact foundation inspection failed: invalid arguments; run with --help for usage\n',
  });
  expect(validateAccess).not.toHaveBeenCalled();
  expect(createReaderMock).not.toHaveBeenCalled();
});

test('runs preflight before exact-target clients and prints a redacted dry-run report', async () => {
  const events: string[] = [];

  const result = await run([], successfulDependencies(events));

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('Artifact foundation cleanup readiness check (read-only)');
  expect(result.stdout).toContain('Final cleanup readiness: READY');
  expect(result.stdout).toContain('DRY RUN: no AWS resources were changed.');
  expect(result.stdout).toContain(TEST_DIGEST_A);
  expect(result.stdout).toContain('<account ending 1111>');
  expect(result.stdout).not.toContain(TEST_TARGET.accountId);
  expect(result.stdout).not.toContain(TEST_TARGET.expectedRoleName);
  expect(events).toEqual([
    'preflight',
    'clients:movie-platform-demo:eu-central-1:/test-home/.aws/config:/test-home/.aws/credentials',
    'identity',
    'stack:MovieReservationWorkloadStack',
    'stack:ArtifactFoundationStack',
    'repository:reservation-service',
  ]);
});

test('stops on a preflight target failure before constructing SDK clients', async () => {
  const createReaderMock = jest.fn(() => createReader({}));

  const result = await run([], {
    validateAccess: () => {
      throw new PreflightFailure('the live caller account does not match the pinned target');
    },
    createReader: createReaderMock,
    artifactRepositoryCatalog: TEST_ARTIFACT_REPOSITORY_CATALOG,
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('live caller account does not match');
  expect(createReaderMock).not.toHaveBeenCalled();
});

test('does not forward unexpected SDK diagnostics or private account values', async () => {
  const result = await run([], {
    validateAccess: () => TEST_ACCESS,
    createReader: () => ({
      verifyIdentity: async () => undefined,
      inspectStack: async () => {
        throw new Error('private SDK failure for 111111111111');
      },
      inspectRepository: async () => REPOSITORY,
    }),
    artifactRepositoryCatalog: TEST_ARTIFACT_REPOSITORY_CATALOG,
  });

  expect(result).toEqual({
    status: 1,
    stdout: '',
    stderr: 'Artifact foundation inspection failed: unexpected internal error\n',
  });
});
