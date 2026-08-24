import {
  CLEANUP_BLOCKER_CODES,
  CLEANUP_READINESS,
  CLEANUP_WARNING_CODES,
} from './model';
import type {
  ArtifactRepositoryDefinition,
  ArtifactRepositoryInspection,
  CleanupBlockerCode,
  CleanupReadiness,
  CleanupWarningCode,
  InspectionIssue,
  RepositoryInspection,
  StackInspection,
} from './model';

export interface CleanupReadinessInput {
  readonly workloadStack?: StackInspection;
  readonly foundationStack?: StackInspection;
  readonly repositories: readonly ArtifactRepositoryInspection[];
}

export interface CleanupReadinessAssessment {
  readonly readiness: CleanupReadiness;
  readonly blockers: readonly InspectionIssue<CleanupBlockerCode>[];
  readonly warnings: readonly InspectionIssue<CleanupWarningCode>[];
}

/** Applies the final-cleanup safety rules to already-inspected AWS state. */
export function evaluateCleanupReadiness(
  input: CleanupReadinessInput,
): CleanupReadinessAssessment {
  const blockers = findBlockingIssues(input);
  const warnings = findAdvisoryIssues(input);

  return Object.freeze({
    readiness: determineReadiness(blockers, input),
    blockers: Object.freeze(blockers),
    warnings: Object.freeze(warnings),
  });
}

/** Blocking issues are states where deletion would be unsafe or ambiguous. */
function findBlockingIssues({
  workloadStack,
  foundationStack,
  repositories,
}: CleanupReadinessInput): InspectionIssue<CleanupBlockerCode>[] {
  const blockers: InspectionIssue<CleanupBlockerCode>[] = [];

  if (workloadStack !== undefined) {
    blockers.push(
      createInspectionIssue(
        CLEANUP_BLOCKER_CODES.WORKLOAD_STACK_PRESENT,
        'the disposable workload stack still exists',
      ),
    );
  }
  if (foundationStack?.status.endsWith('_IN_PROGRESS') === true) {
    blockers.push(
      createInspectionIssue(
        CLEANUP_BLOCKER_CODES.FOUNDATION_OPERATION_IN_PROGRESS,
        'the foundation stack has an operation in progress',
      ),
    );
  }
  if (foundationStack !== undefined) {
    blockers.push(...findFoundationRepositoryBlockers(foundationStack, repositories));
  }

  return blockers;
}

/** Checks that the foundation stack outputs still point at the inspected repositories. */
function findFoundationRepositoryBlockers(
  foundationStack: StackInspection,
  repositories: readonly ArtifactRepositoryInspection[],
): InspectionIssue<CleanupBlockerCode>[] {
  const blockers: InspectionIssue<CleanupBlockerCode>[] = [];

  for (const { definition, repository } of repositories) {
    if (repository === undefined) {
      blockers.push(
        createInspectionIssue(
          CLEANUP_BLOCKER_CODES.FOUNDATION_REPOSITORY_ABSENT,
          `the foundation stack exists but expected ECR repository ${definition.repositoryName} is absent`,
          definition.componentId,
        ),
      );
      continue;
    }

    for (const [outputName, expectedValue] of repositoryOutputChecks(definition, repository)) {
      if (foundationStack.outputs[outputName] !== expectedValue) {
        blockers.push(
          createInspectionIssue(
            CLEANUP_BLOCKER_CODES.FOUNDATION_OUTPUT_MISMATCH,
            `foundation output ${outputName} does not match the inspected repository`,
            definition.componentId,
          ),
        );
      }
    }
  }

  return blockers;
}

function repositoryOutputChecks(
  definition: ArtifactRepositoryDefinition,
  repository: RepositoryInspection,
): readonly (readonly [string, string])[] {
  return [
    [definition.outputNames.name, repository.name],
    [definition.outputNames.arn, repository.arn],
    [definition.outputNames.uri, repository.uri],
  ];
}

/** Advisory issues describe drift or retryable partial-cleanup states. */
function findAdvisoryIssues({
  foundationStack,
  repositories,
}: CleanupReadinessInput): InspectionIssue<CleanupWarningCode>[] {
  const warnings: InspectionIssue<CleanupWarningCode>[] = [];

  if (foundationStack !== undefined && !foundationStack.terminationProtection) {
    warnings.push(
      createInspectionIssue(
        CLEANUP_WARNING_CODES.FOUNDATION_TERMINATION_PROTECTION_DISABLED,
        'foundation stack termination protection is disabled',
      ),
    );
  }

  for (const { definition, repository } of repositories) {
    if (foundationStack === undefined && repository !== undefined) {
      warnings.push(
        createInspectionIssue(
          CLEANUP_WARNING_CODES.RETAINED_REPOSITORY_WITHOUT_STACK,
          `the stack is absent but retained ECR repository ${repository.name} still exists`,
          definition.componentId,
        ),
      );
    }
    if (repository !== undefined) {
      warnings.push(...findRepositoryDriftWarnings(definition, repository));
    }
  }

  return warnings;
}

/** Compares live ECR settings against the approved artifact-foundation contract. */
function findRepositoryDriftWarnings(
  definition: ArtifactRepositoryDefinition,
  repository: RepositoryInspection,
): InspectionIssue<CleanupWarningCode>[] {
  const warnings: InspectionIssue<CleanupWarningCode>[] = [];

  if (repository.tagMutability !== 'IMMUTABLE') {
    warnings.push(
      createInspectionIssue(
        CLEANUP_WARNING_CODES.REPOSITORY_TAG_MUTABILITY_DRIFT,
        'repository tags are not fully immutable',
        definition.componentId,
      ),
    );
  }
  if (repository.tagMutabilityExclusions.length > 0) {
    warnings.push(
      createInspectionIssue(
        CLEANUP_WARNING_CODES.REPOSITORY_TAG_MUTABILITY_EXCLUSIONS_PRESENT,
        'repository tag-mutability exclusions are present',
        definition.componentId,
      ),
    );
  }
  if (repository.scanOnPush === true) {
    warnings.push(
      createInspectionIssue(
        CLEANUP_WARNING_CODES.REPOSITORY_SCAN_CONFIGURATION_DRIFT,
        'repository scan-on-push is enabled instead of the approved manual mode',
        definition.componentId,
      ),
    );
  } else if (repository.scanOnPush === undefined) {
    warnings.push(
      createInspectionIssue(
        CLEANUP_WARNING_CODES.REPOSITORY_SCAN_CONFIGURATION_UNKNOWN,
        'repository scan-on-push setting was not returned by ECR',
        definition.componentId,
      ),
    );
  }
  if (repository.encryptionType !== 'AES256') {
    warnings.push(
      createInspectionIssue(
        CLEANUP_WARNING_CODES.REPOSITORY_ENCRYPTION_DRIFT,
        'repository encryption differs from the approved AES256 lab setting',
        definition.componentId,
      ),
    );
  }
  if (!matchesExpectedLifecyclePolicy(repository.lifecyclePolicyText)) {
    warnings.push(
      createInspectionIssue(
        CLEANUP_WARNING_CODES.REPOSITORY_LIFECYCLE_POLICY_DRIFT,
        'repository lifecycle policy differs from seven-day untagged expiration',
        definition.componentId,
      ),
    );
  }
  if (!hasExactTags(repository.tags, definition.expectedTags)) {
    warnings.push(
      createInspectionIssue(
        CLEANUP_WARNING_CODES.REPOSITORY_TAGS_DRIFT,
        'repository tags differ from the approved ownership tag set',
        definition.componentId,
      ),
    );
  }

  return warnings;
}

function determineReadiness(
  blockers: readonly InspectionIssue<CleanupBlockerCode>[],
  { foundationStack, repositories }: CleanupReadinessInput,
): CleanupReadiness {
  if (blockers.length > 0) {
    return CLEANUP_READINESS.BLOCKED;
  }
  if (
    foundationStack === undefined &&
    repositories.every(({ repository }) => repository === undefined)
  ) {
    return CLEANUP_READINESS.NOTHING_TO_CLEAN;
  }
  return CLEANUP_READINESS.READY;
}

function createInspectionIssue<Code extends string>(
  code: Code,
  message: string,
  componentId?: string,
): InspectionIssue<Code> {
  if (componentId === undefined) {
    return Object.freeze({ code, message });
  }
  return Object.freeze({ code, componentId, message });
}

/**
 * Requires operator-managed live tags to match the configured set exactly.
 * AWS-reserved `aws:*` tags are service metadata and are not configuration
 * drift owned by this repository.
 */
function hasExactTags(
  tags: Readonly<Record<string, string>>,
  expectedTags: Readonly<Record<string, string>>,
): boolean {
  const expectedEntries = Object.entries(expectedTags);
  const operatorManagedEntries = Object.entries(tags).filter(
    ([key]) => !key.startsWith('aws:'),
  );

  return (
    operatorManagedEntries.length === expectedEntries.length &&
    expectedEntries.every(([key, value]) => tags[key] === value)
  );
}

/** Accepts only the approved seven-day untagged-image expiry policy. */
function matchesExpectedLifecyclePolicy(policyText: string | undefined): boolean {
  if (policyText === undefined) {
    return false;
  }

  let value: unknown;
  try {
    value = JSON.parse(policyText) as unknown;
  } catch {
    return false;
  }

  if (!isRecord(value) || !Array.isArray(value.rules) || value.rules.length !== 1) {
    return false;
  }
  const rule = value.rules[0];
  if (!isRecord(rule) || !isRecord(rule.selection) || !isRecord(rule.action)) {
    return false;
  }

  return (
    rule.selection.tagStatus === 'untagged' &&
    rule.selection.countType === 'sinceImagePushed' &&
    rule.selection.countNumber === 7 &&
    rule.selection.countUnit === 'days' &&
    rule.action.type === 'expire'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
