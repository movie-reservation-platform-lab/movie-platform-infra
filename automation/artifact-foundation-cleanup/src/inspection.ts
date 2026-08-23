import {
  ARTIFACT_FOUNDATION_STACK_NAME,
  WORKLOAD_STACK_NAME,
  type ArtifactFoundationInspection,
  type ArtifactFoundationReader,
  type ArtifactRepositoryCatalog,
  type ArtifactRepositoryDefinition,
  type ArtifactRepositoryInspection,
  type CleanupInspectionAccess,
} from './model';
import { evaluateCleanupReadiness } from './cleanup-readiness-policy';

/**
 * Reads the cleanup target and returns the dry-run safety decision (is it possible to clean up?).
 */
export async function inspectArtifactFoundation(
  access: CleanupInspectionAccess,
  reader: ArtifactFoundationReader,
  catalog: ArtifactRepositoryCatalog,
): Promise<ArtifactFoundationInspection> {
  await reader.verifyIdentity();

  const repositoryDefinitions = catalog.listArtifactRepositories();
  const [workloadStack, foundationStack, repositories] = await Promise.all([
    reader.inspectStack(WORKLOAD_STACK_NAME),
    reader.inspectStack(ARTIFACT_FOUNDATION_STACK_NAME),
    inspectConfiguredRepositories(reader, repositoryDefinitions),
  ]);
  const assessment = evaluateCleanupReadiness({
    workloadStack,
    foundationStack,
    repositories,
  });

  return Object.freeze({
    target: access.target,
    permissionSet: access.permissionSet,
    workloadStack,
    foundationStack,
    repositories,
    readiness: assessment.readiness,
    blockers: assessment.blockers,
    warnings: assessment.warnings,
  });
}

/**
 * Inspects each configured ECR destination while preserving its catalog identity.
 */
async function inspectConfiguredRepositories(
  reader: ArtifactFoundationReader,
  definitions: readonly ArtifactRepositoryDefinition[],
): Promise<readonly ArtifactRepositoryInspection[]> {
  const inspectionPromises = definitions.map((definition) =>
    inspectConfiguredRepository(reader, definition),
  );
  const inspections = await Promise.all(inspectionPromises);

  return Object.freeze(inspections);
}

async function inspectConfiguredRepository(
  reader: ArtifactFoundationReader,
  definition: ArtifactRepositoryDefinition,
): Promise<ArtifactRepositoryInspection> {
  const repository = await reader.inspectRepository(definition);

  return Object.freeze({
    definition,
    repository,
  });
}
