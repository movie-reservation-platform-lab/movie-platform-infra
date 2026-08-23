import { inspectArtifactFoundation } from '../src/inspection';
import { renderInspectionReport } from '../src/report';
import {
  FOUNDATION_STACK,
  REPOSITORY,
  TEST_ARTIFACT_REPOSITORY_CATALOG,
  TEST_INSPECTION_ACCESS,
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
