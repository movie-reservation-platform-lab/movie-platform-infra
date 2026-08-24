import { inspectArtifactFoundation } from '../src/inspection';
import {
  renderExecutionPlan,
  renderExecutionResult,
  renderInspectionReport,
} from '../src/report';
import { buildCleanupConfirmation, planArtifactFoundationCleanup } from '../src/cleanup';
import { CLEANUP_EXECUTION_OUTCOME } from '../src/model';
import {
  FOUNDATION_STACK,
  REPOSITORY,
  TEST_ARTIFACT_REPOSITORY_CATALOG,
  TEST_INSPECTION_ACCESS,
  TEST_TARGET,
  createReader,
} from './test-support';

test('renders stable issue codes together with human-readable explanations', async () => {
  const repository = {
    ...REPOSITORY,
    tagMutability: 'MUTABLE',
  };
  const inspection = await inspectArtifactFoundation(
    TEST_INSPECTION_ACCESS,
    createReader({ foundationStack: FOUNDATION_STACK, repositories: [repository] }),
    TEST_ARTIFACT_REPOSITORY_CATALOG,
  );

  const report = renderInspectionReport(inspection);

  expect(report).toContain(
    '  - [REPOSITORY_TAG_MUTABILITY_DRIFT] [reservation-service] repository tags are not fully immutable',
  );
  expect(report).not.toContain('[object Object]');
});

test('renders destructive operations without exposing the full account ID', async () => {
  const inspection = await inspectArtifactFoundation(
    TEST_INSPECTION_ACCESS,
    createReader({ foundationStack: FOUNDATION_STACK, repositories: [REPOSITORY] }),
    TEST_ARTIFACT_REPOSITORY_CATALOG,
  );
  const plan = planArtifactFoundationCleanup(
    inspection,
    buildCleanupConfirmation(TEST_TARGET),
  );

  const report = renderExecutionPlan(plan);

  expect(report).toContain('cleanup execution plan (destructive)');
  expect(report).toContain('Disable termination protection');
  expect(report).toContain('Force-delete ECR repository movie-reservation-service');
  expect(report).toContain('account-1111');
  expect(report).not.toContain(TEST_TARGET.accountId);
});

test('renders success only as a final verified cleanup result', () => {
  const report = renderExecutionResult({
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

  expect(report).toContain('Cleanup result: CLEANED');
  expect(report).toContain('final absence verification: passed');
});
