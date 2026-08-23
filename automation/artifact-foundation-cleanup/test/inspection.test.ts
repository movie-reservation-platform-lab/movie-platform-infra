import { inspectArtifactFoundation } from '../src/inspection';
import {
  CLEANUP_BLOCKER_CODES,
  CLEANUP_READINESS,
  CLEANUP_WARNING_CODES,
} from '../src/model';
import {
  FOUNDATION_STACK,
  REPOSITORY,
  RESERVATION_SERVICE_REPOSITORY_DEFINITION,
  TEST_ARTIFACT_REPOSITORY_CATALOG,
  TEST_INSPECTION_ACCESS,
  WORKLOAD_STACK,
  createReader,
} from './test-support';

test('marks the normal protected foundation as ready after workload teardown', async () => {
  const inspection = await inspectArtifactFoundation(
    TEST_INSPECTION_ACCESS,
    createReader({ foundationStack: FOUNDATION_STACK, repositories: [REPOSITORY] }),
    TEST_ARTIFACT_REPOSITORY_CATALOG,
  );

  expect(inspection.readiness).toBe(CLEANUP_READINESS.READY);
  expect(inspection.blockers).toEqual([]);
  expect(inspection.warnings).toEqual([]);
  expect(inspection.repositories).toHaveLength(1);
  expect(inspection.repositories[0].definition.componentId).toBe(
    RESERVATION_SERVICE_REPOSITORY_DEFINITION.componentId,
  );
  expect(inspection.repositories[0].repository?.componentId).toBe(
    RESERVATION_SERVICE_REPOSITORY_DEFINITION.componentId,
  );
});

test('blocks cleanup while the disposable workload stack exists', async () => {
  const inspection = await inspectArtifactFoundation(
    TEST_INSPECTION_ACCESS,
    createReader({
      workloadStack: WORKLOAD_STACK,
      foundationStack: FOUNDATION_STACK,
      repositories: [REPOSITORY],
    }),
    TEST_ARTIFACT_REPOSITORY_CATALOG,
  );

  expect(inspection.readiness).toBe(CLEANUP_READINESS.BLOCKED);
  expect(inspection.blockers).toContainEqual({
    code: CLEANUP_BLOCKER_CODES.WORKLOAD_STACK_PRESENT,
    message: 'the disposable workload stack still exists',
  });
});

test('recognizes complete absence as nothing to clean', async () => {
  const inspection = await inspectArtifactFoundation(
    TEST_INSPECTION_ACCESS,
    createReader({}),
    TEST_ARTIFACT_REPOSITORY_CATALOG,
  );

  expect(inspection.readiness).toBe(CLEANUP_READINESS.NOTHING_TO_CLEAN);
  expect(inspection.blockers).toEqual([]);
});

test('recognizes a retained repository after stack deletion as a resumable state', async () => {
  const inspection = await inspectArtifactFoundation(
    TEST_INSPECTION_ACCESS,
    createReader({ repositories: [REPOSITORY] }),
    TEST_ARTIFACT_REPOSITORY_CATALOG,
  );

  expect(inspection.readiness).toBe(CLEANUP_READINESS.READY);
  expect(inspection.blockers).toEqual([]);
  expect(inspection.warnings).toContainEqual({
    code: CLEANUP_WARNING_CODES.RETAINED_REPOSITORY_WITHOUT_STACK,
    componentId: RESERVATION_SERVICE_REPOSITORY_DEFINITION.componentId,
    message: 'the stack is absent but retained ECR repository movie-reservation-service still exists',
  });
});

test('blocks an inconsistent foundation stack with no expected repository', async () => {
  const inspection = await inspectArtifactFoundation(
    TEST_INSPECTION_ACCESS,
    createReader({ foundationStack: FOUNDATION_STACK }),
    TEST_ARTIFACT_REPOSITORY_CATALOG,
  );

  expect(inspection.readiness).toBe(CLEANUP_READINESS.BLOCKED);
  expect(inspection.blockers).toContainEqual({
    code: CLEANUP_BLOCKER_CODES.FOUNDATION_REPOSITORY_ABSENT,
    componentId: RESERVATION_SERVICE_REPOSITORY_DEFINITION.componentId,
    message:
      'the foundation stack exists but expected ECR repository movie-reservation-service is absent',
  });
});

test('blocks cleanup while a foundation stack operation is in progress', async () => {
  const foundationStack = {
    ...FOUNDATION_STACK,
    status: 'UPDATE_IN_PROGRESS',
  };
  const inspection = await inspectArtifactFoundation(
    TEST_INSPECTION_ACCESS,
    createReader({ foundationStack, repositories: [REPOSITORY] }),
    TEST_ARTIFACT_REPOSITORY_CATALOG,
  );

  expect(inspection.readiness).toBe(CLEANUP_READINESS.BLOCKED);
  expect(inspection.blockers).toContainEqual({
    code: CLEANUP_BLOCKER_CODES.FOUNDATION_OPERATION_IN_PROGRESS,
    message: 'the foundation stack has an operation in progress',
  });
});

test('blocks mismatched foundation discovery outputs without exposing their values', async () => {
  const foundationStack = {
    ...FOUNDATION_STACK,
    outputs: {
      ...FOUNDATION_STACK.outputs,
      MovieReservationServiceRepositoryUri: 'wrong-uri',
    },
  };
  const inspection = await inspectArtifactFoundation(
    TEST_INSPECTION_ACCESS,
    createReader({ foundationStack, repositories: [REPOSITORY] }),
    TEST_ARTIFACT_REPOSITORY_CATALOG,
  );

  expect(inspection.readiness).toBe(CLEANUP_READINESS.BLOCKED);
  expect(inspection.blockers).toEqual([
    {
      code: CLEANUP_BLOCKER_CODES.FOUNDATION_OUTPUT_MISMATCH,
      componentId: RESERVATION_SERVICE_REPOSITORY_DEFINITION.componentId,
      message:
        'foundation output MovieReservationServiceRepositoryUri does not match the inspected repository',
    },
  ]);
  expect(inspection.blockers.map(({ message }) => message).join('\n')).not.toContain('wrong-uri');
});

test('reports configuration drift as warnings while preserving read-only readiness', async () => {
  const repository = {
    ...REPOSITORY,
    tagMutability: 'MUTABLE',
    tagMutabilityExclusions: ['WILDCARD:latest'],
    scanOnPush: true,
    encryptionType: 'KMS',
    tags: { Scope: 'unexpected' },
    lifecyclePolicyText: undefined,
  };
  const inspection = await inspectArtifactFoundation(
    TEST_INSPECTION_ACCESS,
    createReader({ foundationStack: FOUNDATION_STACK, repositories: [repository] }),
    TEST_ARTIFACT_REPOSITORY_CATALOG,
  );

  expect(inspection.readiness).toBe(CLEANUP_READINESS.READY);
  expect(inspection.warnings.map(({ code }) => code)).toEqual([
    CLEANUP_WARNING_CODES.REPOSITORY_TAG_MUTABILITY_DRIFT,
    CLEANUP_WARNING_CODES.REPOSITORY_TAG_MUTABILITY_EXCLUSIONS_PRESENT,
    CLEANUP_WARNING_CODES.REPOSITORY_SCAN_CONFIGURATION_DRIFT,
    CLEANUP_WARNING_CODES.REPOSITORY_ENCRYPTION_DRIFT,
    CLEANUP_WARNING_CODES.REPOSITORY_LIFECYCLE_POLICY_DRIFT,
    CLEANUP_WARNING_CODES.REPOSITORY_TAGS_DRIFT,
  ]);
});
