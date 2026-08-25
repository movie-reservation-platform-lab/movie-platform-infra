import {
  buildCleanupConfirmation,
  executeArtifactFoundationCleanup,
  planArtifactFoundationCleanup,
} from '../src/cleanup';
import { CleanupFailure } from '../src/cleanup-error';
import { inspectArtifactFoundation } from '../src/inspection';
import { CLEANUP_EXECUTION_OUTCOME, type ArtifactFoundationCleaner } from '../src/model';
import {
  FOUNDATION_STACK,
  MULTI_REPOSITORY_FOUNDATION_STACK,
  REPOSITORY,
  TEST_ARTIFACT_REPOSITORY_CATALOG,
  TEST_INSPECTION_ACCESS,
  TEST_MULTI_REPOSITORY_CATALOG,
  TEST_TARGET,
  WEB_REPOSITORY,
  WORKLOAD_STACK,
  createCleaner,
  createReader,
  type ReaderState,
} from './test-support';

async function inspect(state: ReaderState) {
  return inspectArtifactFoundation(
    TEST_INSPECTION_ACCESS,
    createReader(state),
    TEST_ARTIFACT_REPOSITORY_CATALOG,
  );
}

test('derives exact mutation targets from current inspected resources', async () => {
  const inspection = await inspect({
    foundationStack: FOUNDATION_STACK,
    repositories: [REPOSITORY],
  });

  const plan = planArtifactFoundationCleanup(
    inspection,
    buildCleanupConfirmation(TEST_TARGET),
  );

  expect(plan).toEqual({
    target: TEST_TARGET,
    foundationStack: {
      name: 'ArtifactFoundationStack',
      disableTerminationProtection: true,
    },
    repositories: [
      {
        componentId: 'reservation-service',
        registryId: TEST_TARGET.accountId,
        name: 'movie-reservation-service',
      },
    ],
  });
});

test('requires an exact account- and Region-specific confirmation', async () => {
  const inspection = await inspect({
    foundationStack: FOUNDATION_STACK,
    repositories: [REPOSITORY],
  });

  expect(buildCleanupConfirmation(TEST_TARGET)).toBe(
    'DELETE ArtifactFoundationStack AND RETAINED ECR FROM ' +
      'movie-platform-demo/eu-central-1/account-1111',
  );
  expect(() => planArtifactFoundationCleanup(inspection, 'almost correct')).toThrow(
    CleanupFailure,
  );
});

test('recomputes blockers from resource state instead of trusting serialized readiness', async () => {
  const blockedInspection = await inspect({
    workloadStack: WORKLOAD_STACK,
    foundationStack: FOUNDATION_STACK,
    repositories: [REPOSITORY],
  });
  const inconsistentInspection = {
    ...blockedInspection,
    readiness: 'READY' as const,
    blockers: [],
  };

  expect(() =>
    planArtifactFoundationCleanup(
      inconsistentInspection,
      buildCleanupConfirmation(TEST_TARGET),
    ),
  ).toThrow('WORKLOAD_STACK_PRESENT');
});

test('executes normal cleanup in fail-closed order and verifies final absence', async () => {
  const inspection = await inspect({
    foundationStack: FOUNDATION_STACK,
    repositories: [REPOSITORY],
  });
  const plan = planArtifactFoundationCleanup(
    inspection,
    buildCleanupConfirmation(TEST_TARGET),
  );
  const events: string[] = [];

  const result = await executeArtifactFoundationCleanup(
    plan,
    createCleaner(events),
    async () => {
      events.push('final-inspection');
      return inspect({});
    },
  );

  expect(result).toEqual({
    outcome: CLEANUP_EXECUTION_OUTCOME.CLEANED,
    foundationStackDeleted: true,
    deletedRepositories: [
      {
        componentId: 'reservation-service',
        registryId: TEST_TARGET.accountId,
        name: 'movie-reservation-service',
      },
    ],
  });
  expect(events).toEqual([
    'cleanup-identity',
    'disable-protection:ArtifactFoundationStack',
    'delete-stack:ArtifactFoundationStack',
    'wait-stack:ArtifactFoundationStack',
    'delete-repository:reservation-service:111111111111:movie-reservation-service',
    'final-inspection',
  ]);
});

test('inspects and cleans multiple repositories in catalog order before final absence verification', async () => {
  const inspection = await inspectArtifactFoundation(
    TEST_INSPECTION_ACCESS,
    createReader({
      foundationStack: MULTI_REPOSITORY_FOUNDATION_STACK,
      repositories: [WEB_REPOSITORY, REPOSITORY],
    }),
    TEST_MULTI_REPOSITORY_CATALOG,
  );
  expect(inspection.repositories.map(({ definition }) => definition.componentId)).toEqual([
    'reservation-service',
    'reservation-web',
  ]);

  const plan = planArtifactFoundationCleanup(
    inspection,
    buildCleanupConfirmation(TEST_TARGET),
  );
  const events: string[] = [];
  const result = await executeArtifactFoundationCleanup(
    plan,
    createCleaner(events),
    async () => {
      events.push('final-inspection');
      return inspectArtifactFoundation(
        TEST_INSPECTION_ACCESS,
        createReader({}),
        TEST_MULTI_REPOSITORY_CATALOG,
      );
    },
  );

  expect(result.deletedRepositories.map(({ componentId }) => componentId)).toEqual([
    'reservation-service',
    'reservation-web',
  ]);
  expect(events).toEqual([
    'cleanup-identity',
    'disable-protection:ArtifactFoundationStack',
    'delete-stack:ArtifactFoundationStack',
    'wait-stack:ArtifactFoundationStack',
    'delete-repository:reservation-service:111111111111:movie-reservation-service',
    'delete-repository:reservation-web:111111111111:movie-reservation-web',
    'final-inspection',
  ]);
});

test('skips the protection update when protection is already disabled', async () => {
  const inspection = await inspect({
    foundationStack: { ...FOUNDATION_STACK, terminationProtection: false },
    repositories: [REPOSITORY],
  });
  const plan = planArtifactFoundationCleanup(
    inspection,
    buildCleanupConfirmation(TEST_TARGET),
  );
  const events: string[] = [];

  await executeArtifactFoundationCleanup(plan, createCleaner(events), async () => inspect({}));

  expect(events).not.toContain('disable-protection:ArtifactFoundationStack');
  expect(events).toContain('delete-stack:ArtifactFoundationStack');
});

test.each([
  ['termination protection update', 'disableStackTerminationProtection'],
  ['stack request', 'deleteStack'],
  ['stack waiter', 'waitForStackDeletion'],
] as const)(
  '%s failure prevents retained repository deletion',
  async (_scenario, failingMethod) => {
    const inspection = await inspect({
      foundationStack: FOUNDATION_STACK,
      repositories: [REPOSITORY],
    });
    const plan = planArtifactFoundationCleanup(
      inspection,
      buildCleanupConfirmation(TEST_TARGET),
    );
    const events: string[] = [];
    const baseCleaner = createCleaner(events);
    const cleaner: ArtifactFoundationCleaner = {
      ...baseCleaner,
      [failingMethod]: async (stackName: string) => {
        events.push(`failed:${failingMethod}:${stackName}`);
        throw new CleanupFailure(`${failingMethod} failed`);
      },
    };

    await expect(
      executeArtifactFoundationCleanup(plan, cleaner, async () => inspect({})),
    ).rejects.toThrow(`${failingMethod} failed`);

    expect(events.some((event) => event.startsWith('delete-repository:'))).toBe(false);
  },
);

test('repository deletion failure leaves a retryable orphaned-repository path', async () => {
  const initialInspection = await inspect({
    foundationStack: FOUNDATION_STACK,
    repositories: [REPOSITORY],
  });
  const initialPlan = planArtifactFoundationCleanup(
    initialInspection,
    buildCleanupConfirmation(TEST_TARGET),
  );
  const failingCleaner: ArtifactFoundationCleaner = {
    ...createCleaner(),
    deleteRepository: async () => {
      throw new CleanupFailure('repository deletion failed');
    },
  };

  await expect(
    executeArtifactFoundationCleanup(initialPlan, failingCleaner, async () => inspect({})),
  ).rejects.toThrow('repository deletion failed');

  const retryInspection = await inspect({ repositories: [REPOSITORY] });
  const retryPlan = planArtifactFoundationCleanup(
    retryInspection,
    buildCleanupConfirmation(TEST_TARGET),
  );
  const retryEvents: string[] = [];
  await expect(
    executeArtifactFoundationCleanup(retryPlan, createCleaner(retryEvents), async () => inspect({})),
  ).resolves.toMatchObject({ outcome: CLEANUP_EXECUTION_OUTCOME.CLEANED });

  expect(retryEvents).toEqual([
    'cleanup-identity',
    'delete-repository:reservation-service:111111111111:movie-reservation-service',
  ]);
});

test('already-absent state returns without constructing AWS-side effects or reinspection', async () => {
  const inspection = await inspect({});
  const plan = planArtifactFoundationCleanup(
    inspection,
    buildCleanupConfirmation(TEST_TARGET),
  );
  const cleaner = createCleaner();
  const finalInspection = jest.fn(async () => inspect({}));

  await expect(
    executeArtifactFoundationCleanup(plan, cleaner, finalInspection),
  ).resolves.toEqual({
    outcome: CLEANUP_EXECUTION_OUTCOME.NOTHING_TO_CLEAN,
    foundationStackDeleted: false,
    deletedRepositories: [],
  });
  expect(finalInspection).not.toHaveBeenCalled();
});

test('fails when fresh verification still finds a configured cleanup target', async () => {
  const inspection = await inspect({ repositories: [REPOSITORY] });
  const plan = planArtifactFoundationCleanup(
    inspection,
    buildCleanupConfirmation(TEST_TARGET),
  );

  await expect(
    executeArtifactFoundationCleanup(plan, createCleaner(), async () =>
      inspect({ repositories: [REPOSITORY] }),
    ),
  ).rejects.toThrow('final absence verification failed for: reservation-service');
});
