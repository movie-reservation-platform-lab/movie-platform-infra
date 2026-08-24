import { PreflightFailure } from '../../aws-account-preflight/src';
import { buildCleanupConfirmation } from '../src/cleanup';
import { runCli, type CliDependencies } from '../src';
import {
  FOUNDATION_STACK,
  REPOSITORY,
  TEST_ACCESS,
  TEST_ARTIFACT_REPOSITORY_CATALOG,
  TEST_DIGEST_A,
  TEST_TARGET,
  WORKLOAD_STACK,
  createCleaner,
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
        `reader:${access.target.profile}:${access.target.region}:` +
          `${access.configFiles.configFilepath}:${access.configFiles.credentialsFilepath}`,
      );
      let inspectionNumber = 0;
      return {
        verifyIdentity: async () => {
          inspectionNumber += 1;
          events.push(`read-identity:${inspectionNumber}`);
        },
        inspectStack: async (stackName) => {
          events.push(`stack:${inspectionNumber}:${stackName}`);
          if (inspectionNumber > 1) {
            return undefined;
          }
          return stackName === FOUNDATION_STACK.name ? FOUNDATION_STACK : undefined;
        },
        inspectRepository: async (definition) => {
          events.push(`repository:${inspectionNumber}:${definition.componentId}`);
          return inspectionNumber > 1 ? undefined : REPOSITORY;
        },
      };
    },
    createCleaner: (access) => {
      events.push(`cleaner:${access.target.profile}:${access.target.region}`);
      return createCleaner(events);
    },
    artifactRepositoryCatalog: TEST_ARTIFACT_REPOSITORY_CATALOG,
  };
}

test.each([['--help'], ['-h']])('prints help without target access for %s', async (argument) => {
  const validateAccess = jest.fn(() => TEST_ACCESS);
  const createReaderMock = jest.fn(() => createReader({}));
  const createCleanerMock = jest.fn(() => createCleaner());

  const result = await run([argument], {
    validateAccess,
    createReader: createReaderMock,
    createCleaner: createCleanerMock,
    artifactRepositoryCatalog: TEST_ARTIFACT_REPOSITORY_CATALOG,
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('npm run cleanup:artifact-foundation -- [--help]');
  expect(result.stdout).toContain('--execute --confirm');
  expect(result.stdout).toContain('MovieReservationWorkloadStack');
  expect(result.stdout).toContain('WARNING: --execute is destructive');
  expect(validateAccess).not.toHaveBeenCalled();
  expect(createReaderMock).not.toHaveBeenCalled();
  expect(createCleanerMock).not.toHaveBeenCalled();
});

test('requires confirmation before preflight or client creation', async () => {
  const validateAccess = jest.fn(() => TEST_ACCESS);
  const createReaderMock = jest.fn(() => createReader({}));
  const createCleanerMock = jest.fn(() => createCleaner());

  const result = await run(['--execute'], {
    validateAccess,
    createReader: createReaderMock,
    createCleaner: createCleanerMock,
    artifactRepositoryCatalog: TEST_ARTIFACT_REPOSITORY_CATALOG,
  });

  expect(result).toEqual({
    status: 1,
    stdout: '',
    stderr:
      'Artifact foundation cleanup failed: --execute requires an exact --confirm value; run the read-only check first\n',
  });
  expect(validateAccess).not.toHaveBeenCalled();
  expect(createReaderMock).not.toHaveBeenCalled();
  expect(createCleanerMock).not.toHaveBeenCalled();
});

test('runs preflight and read-only inspection without constructing a mutation client', async () => {
  const events: string[] = [];

  const result = await run([], successfulDependencies(events));

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('Artifact foundation cleanup readiness check (read-only)');
  expect(result.stdout).toContain('Final cleanup readiness: READY');
  expect(result.stdout).toContain(buildCleanupConfirmation(TEST_TARGET));
  expect(result.stdout).toContain('DRY RUN: no AWS resources were changed.');
  expect(result.stdout).toContain(TEST_DIGEST_A);
  expect(result.stdout).toContain('<account ending 1111>');
  expect(result.stdout).not.toContain(TEST_TARGET.accountId);
  expect(result.stdout).not.toContain(TEST_TARGET.expectedRoleName);
  expect(events).toEqual([
    'preflight',
    'reader:movie-platform-demo:eu-central-1:/test-home/.aws/config:/test-home/.aws/credentials',
    'read-identity:1',
    'stack:1:MovieReservationWorkloadStack',
    'stack:1:ArtifactFoundationStack',
    'repository:1:reservation-service',
  ]);
});

test('rejects a wrong target-specific confirmation before constructing a mutation client', async () => {
  const events: string[] = [];

  const result = await run(
    ['--execute', '--confirm', 'DELETE THE WRONG TARGET'],
    successfulDependencies(events),
  );

  expect(result.status).toBe(1);
  expect(result.stdout).toContain('Final cleanup readiness: READY');
  expect(result.stderr).toContain('confirmation must exactly match');
  expect(events).not.toContain('cleaner:movie-platform-demo:eu-central-1');
  expect(events).not.toContain('cleanup-identity');
});

test('executes in guarded order and reports success only after final absence verification', async () => {
  const events: string[] = [];

  const result = await run(
    ['--execute', '--confirm', buildCleanupConfirmation(TEST_TARGET)],
    successfulDependencies(events),
  );

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('Artifact foundation cleanup execution plan (destructive)');
  expect(result.stdout).toContain('Force-delete ECR repository movie-reservation-service');
  expect(result.stdout).toContain('Cleanup result: CLEANED');
  expect(result.stdout).toContain('final absence verification: passed');
  expect(events).toEqual([
    'preflight',
    'reader:movie-platform-demo:eu-central-1:/test-home/.aws/config:/test-home/.aws/credentials',
    'read-identity:1',
    'stack:1:MovieReservationWorkloadStack',
    'stack:1:ArtifactFoundationStack',
    'repository:1:reservation-service',
    'cleaner:movie-platform-demo:eu-central-1',
    'cleanup-identity',
    'disable-protection:ArtifactFoundationStack',
    'delete-stack:ArtifactFoundationStack',
    'wait-stack:ArtifactFoundationStack',
    'delete-repository:reservation-service:111111111111:movie-reservation-service',
    'read-identity:2',
    'stack:2:MovieReservationWorkloadStack',
    'stack:2:ArtifactFoundationStack',
    'repository:2:reservation-service',
  ]);
});

test('blocks execution while the workload exists and makes no mutation', async () => {
  const createCleanerMock = jest.fn(() => createCleaner());

  const result = await run(
    ['--execute', '--confirm', buildCleanupConfirmation(TEST_TARGET)],
    {
      validateAccess: () => TEST_ACCESS,
      createReader: () =>
        createReader({
          workloadStack: WORKLOAD_STACK,
          foundationStack: FOUNDATION_STACK,
          repositories: [REPOSITORY],
        }),
      createCleaner: createCleanerMock,
      artifactRepositoryCatalog: TEST_ARTIFACT_REPOSITORY_CATALOG,
    },
  );

  expect(result.status).toBe(1);
  expect(result.stdout).toContain('Final cleanup readiness: BLOCKED');
  expect(result.stderr).toContain('WORKLOAD_STACK_PRESENT');
  expect(createCleanerMock).not.toHaveBeenCalled();
});

test('stops on a preflight target failure before constructing SDK clients', async () => {
  const createReaderMock = jest.fn(() => createReader({}));
  const createCleanerMock = jest.fn(() => createCleaner());

  const result = await run([], {
    validateAccess: () => {
      throw new PreflightFailure('the live caller account does not match the pinned target');
    },
    createReader: createReaderMock,
    createCleaner: createCleanerMock,
    artifactRepositoryCatalog: TEST_ARTIFACT_REPOSITORY_CATALOG,
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('live caller account does not match');
  expect(createReaderMock).not.toHaveBeenCalled();
  expect(createCleanerMock).not.toHaveBeenCalled();
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
    createCleaner: () => createCleaner(),
    artifactRepositoryCatalog: TEST_ARTIFACT_REPOSITORY_CATALOG,
  });

  expect(result).toEqual({
    status: 1,
    stdout: '',
    stderr: 'Artifact foundation inspection failed: unexpected internal error\n',
  });
});
