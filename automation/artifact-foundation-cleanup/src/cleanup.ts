import { evaluateCleanupReadiness } from './cleanup-readiness-policy';
import { failCleanup } from './cleanup-error';
import {
  ARTIFACT_FOUNDATION_STACK_NAME,
  CLEANUP_EXECUTION_OUTCOME,
  type ArtifactFoundationCleaner,
  type ArtifactFoundationInspection,
  type CleanupExecutionPlan,
  type CleanupExecutionResult,
  type CleanupTarget,
  type RepositoryCleanupTarget,
} from './model';

/**
 * Return the exact phrase required to authorize destructive cleanup for one
 * preflight-approved target without printing its full account ID.
 */
export function buildCleanupConfirmation(target: CleanupTarget): string {
  return (
    `DELETE ${ARTIFACT_FOUNDATION_STACK_NAME} AND RETAINED ECR FROM ` +
    `${target.profile}/${target.region}/account-${target.accountId.slice(-4)}`
  );
}

/**
 * Recompute safety from inspected resources and derive exact mutation targets.
 * The serialized READY value and human-readable report are deliberately ignored.
 */
export function planArtifactFoundationCleanup(
  inspection: ArtifactFoundationInspection,
  confirmation: string,
): CleanupExecutionPlan {
  const expectedConfirmation = buildCleanupConfirmation(inspection.target);
  if (confirmation !== expectedConfirmation) {
    failCleanup(
      `confirmation must exactly match ${JSON.stringify(expectedConfirmation)}`,
    );
  }

  const assessment = evaluateCleanupReadiness({
    workloadStack: inspection.workloadStack,
    foundationStack: inspection.foundationStack,
    repositories: inspection.repositories,
  });
  if (assessment.blockers.length > 0) {
    const blockerCodes = assessment.blockers.map(({ code }) => code).join(', ');
    failCleanup(`cleanup is blocked by current AWS state: ${blockerCodes}`);
  }

  const foundationStack = inspection.foundationStack;
  if (
    foundationStack !== undefined &&
    foundationStack.name !== ARTIFACT_FOUNDATION_STACK_NAME
  ) {
    failCleanup('refusing to delete an unexpected CloudFormation stack');
  }

  const repositories = inspection.repositories.flatMap(({ definition, repository }) => {
    if (repository === undefined) {
      return [];
    }
    if (
      repository.componentId !== definition.componentId ||
      repository.name !== definition.repositoryName ||
      repository.registryId !== inspection.target.accountId
    ) {
      failCleanup('refusing to delete an ECR repository outside the inspected catalog target');
    }
    return [
      Object.freeze({
        componentId: repository.componentId,
        registryId: repository.registryId,
        name: repository.name,
      } satisfies RepositoryCleanupTarget),
    ];
  });

  const reportedFoundationStack = foundationStack === undefined
    ? undefined
    : Object.freeze({
      name: foundationStack.name,
      disableTerminationProtection: foundationStack.terminationProtection,
    });

  return Object.freeze({
    target: inspection.target,
    foundationStack: reportedFoundationStack,

    repositories: Object.freeze(repositories),
  });
}

/**
 * Execute the already-approved typed plan in fail-closed order, then require a
 * fresh inspection to prove that the stack and all configured repositories are absent.
 */
export async function executeArtifactFoundationCleanup(
  plan: CleanupExecutionPlan,
  cleaner: ArtifactFoundationCleaner,
  inspectFinalState: () => Promise<ArtifactFoundationInspection>,
): Promise<CleanupExecutionResult> {
  if (plan.foundationStack === undefined && plan.repositories.length === 0) {
    return Object.freeze({
      outcome: CLEANUP_EXECUTION_OUTCOME.NOTHING_TO_CLEAN,
      foundationStackDeleted: false,
      deletedRepositories: Object.freeze([]),
    });
  }

  await cleaner.verifyIdentity();

  if (plan.foundationStack !== undefined) {
    if (plan.foundationStack.disableTerminationProtection) {
      await cleaner.disableStackTerminationProtection(plan.foundationStack.name);
    }
    await cleaner.deleteStack(plan.foundationStack.name);
    await cleaner.waitForStackDeletion(plan.foundationStack.name);
  }

  for (const repository of plan.repositories) {
    await cleaner.deleteRepository(repository);
  }

  const finalInspection = await inspectFinalState();
  const foundationStillExists = finalInspection.foundationStack !== undefined;
  const remainingRepositories = finalInspection.repositories
    .filter(({ repository }) => repository !== undefined)
    .map(({ definition }) => definition.componentId);
  if (foundationStillExists || remainingRepositories.length > 0) {
    const remaining = [
      ...(foundationStillExists ? [ARTIFACT_FOUNDATION_STACK_NAME] : []),
      ...remainingRepositories,
    ].join(', ');
    failCleanup(`final absence verification failed for: ${remaining}`);
  }

  return Object.freeze({
    outcome: CLEANUP_EXECUTION_OUTCOME.CLEANED,
    foundationStackDeleted: plan.foundationStack !== undefined,
    deletedRepositories: plan.repositories,
  });
}
