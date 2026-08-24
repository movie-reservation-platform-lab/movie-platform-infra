import type {
  ArtifactFoundationInspection,
  ArtifactRepositoryInspection,
  CleanupExecutionPlan,
  CleanupExecutionResult,
  InspectionIssue,
  StackInspection,
} from './model';
import { CLEANUP_EXECUTION_OUTCOME, CLEANUP_READINESS } from './model';
import { buildCleanupConfirmation } from './cleanup';

/** Render a stable, account-redacted dry-run report for the operator. */
export function renderInspectionReport(inspection: ArtifactFoundationInspection): string {
  const lines = [
    'Artifact foundation cleanup readiness check (read-only)',
    '',
    'Target:',
    `  profile: ${inspection.target.profile}`,
    `  region: ${inspection.target.region}`,
    `  permission set: ${inspection.permissionSet}`,
    `  account last four: ${inspection.target.accountId.slice(-4)}`,
    '',
    ...renderStack('Workload stack', inspection.workloadStack, inspection.target.accountId),
    '',
    ...renderStack('Artifact foundation stack', inspection.foundationStack, inspection.target.accountId),
    '',
    ...renderRepositories(inspection.repositories, inspection.target.accountId),
    '',
    ...renderMessages('Blockers', inspection.blockers),
    ...renderMessages('Warnings', inspection.warnings),
    `Final cleanup readiness: ${inspection.readiness}`,
    ...renderExecutionGuidance(inspection),
    'DRY RUN: no AWS resources were changed.',
    '',
  ];

  return lines.join('\n');
}

/** Render the exact destructive operations immediately before execution. */
export function renderExecutionPlan(plan: CleanupExecutionPlan): string {
  const lines = [
    'Artifact foundation cleanup execution plan (destructive)',
    '',
    `Target: ${plan.target.profile}/${plan.target.region}/account-${plan.target.accountId.slice(-4)}`,
    'Operations:',
  ];
  let operationNumber = 1;

  if (plan.foundationStack === undefined && plan.repositories.length === 0) {
    lines.push('  (none; the initial inspection already proved the artifact foundation is absent)', '');
    return lines.join('\n');
  }
  if (plan.foundationStack?.disableTerminationProtection === true) {
    lines.push(
      `  ${operationNumber}. Disable termination protection on ${plan.foundationStack.name}.`,
    );
    operationNumber += 1;
  }
  if (plan.foundationStack !== undefined) {
    lines.push(
      `  ${operationNumber}. Delete ${plan.foundationStack.name} and wait for confirmed absence.`,
    );
    operationNumber += 1;
  }
  for (const repository of plan.repositories) {
    lines.push(
      `  ${operationNumber}. Force-delete ECR repository ${repository.name} and every image it contains.`,
    );
    operationNumber += 1;
  }
  lines.push(
    `  ${operationNumber}. Re-inspect the target and require the stack and configured repositories to be absent.`,
    '',
  );
  return lines.join('\n');
}

/** Render success only after the execution workflow verifies final absence. */
export function renderExecutionResult(result: CleanupExecutionResult): string {
  if (result.outcome === CLEANUP_EXECUTION_OUTCOME.NOTHING_TO_CLEAN) {
    return 'Cleanup result: NOTHING_TO_CLEAN; no AWS resources were changed.\n';
  }

  return [
    'Cleanup result: CLEANED',
    `  foundation stack deleted: ${result.foundationStackDeleted ? 'yes' : 'already absent'}`,
    `  retained repositories deleted: ${result.deletedRepositories.length}`,
    '  final absence verification: passed',
    '',
  ].join('\n');
}

function renderExecutionGuidance(inspection: ArtifactFoundationInspection): string[] {
  if (inspection.readiness === CLEANUP_READINESS.BLOCKED) {
    return ['Execution unavailable until every blocker is resolved.'];
  }
  if (inspection.readiness === CLEANUP_READINESS.NOTHING_TO_CLEAN) {
    return ['No cleanup execution is required.'];
  }
  return [
    'Exact execution confirmation:',
    `  ${JSON.stringify(buildCleanupConfirmation(inspection.target))}`,
  ];
}

function renderStack(
  heading: string,
  stack: StackInspection | undefined,
  accountId: string,
): string[] {
  if (stack === undefined) {
    return [`${heading}:`, '  state: ABSENT'];
  }

  const lines = [
    `${heading}:`,
    '  state: PRESENT',
    `  name: ${stack.name}`,
    `  status: ${stack.status}`,
    `  termination protection: ${stack.terminationProtection ? 'enabled' : 'disabled'}`,
    '  outputs:',
  ];
  const outputs = Object.entries(stack.outputs).sort(([left], [right]) => left.localeCompare(right));
  if (outputs.length === 0) {
    lines.push('    (none)');
  } else {
    for (const [key, value] of outputs) {
      lines.push(
        `    ${JSON.stringify(redactAccount(key, accountId))}: ` +
          JSON.stringify(redactAccount(value, accountId)),
      );
    }
  }
  return lines;
}

function renderRepositories(
  repositories: readonly ArtifactRepositoryInspection[],
  accountId: string,
): string[] {
  const lines = ['Artifact repositories:'];
  if (repositories.length === 0) {
    lines.push('  (none configured)');
    return lines;
  }

  for (const repositoryInspection of repositories) {
    lines.push(...renderRepository(repositoryInspection, accountId));
  }
  return lines;
}

function renderRepository(
  inspection: ArtifactRepositoryInspection,
  accountId: string,
): string[] {
  const { definition, repository } = inspection;
  const heading = `  ${definition.componentId} (${definition.repositoryName}):`;

  if (repository === undefined) {
    return [
      heading,
      '    state: ABSENT',
      `    display name: ${definition.displayName}`,
      `    artifact kind: ${definition.artifactKind}`,
    ];
  }

  const lines = [
    heading,
    '    state: PRESENT',
    `    display name: ${repository.displayName}`,
    `    artifact kind: ${repository.artifactKind}`,
    `    name: ${repository.name}`,
    `    registry account last four: ${repository.registryId.slice(-4)}`,
    `    ARN: ${redactAccount(repository.arn, accountId)}`,
    `    URI: ${redactAccount(repository.uri, accountId)}`,
    `    tag mutability: ${repository.tagMutability}`,
    `    mutability exclusions: ${repository.tagMutabilityExclusions.length}`,
    `    scan on push: ${renderBooleanSetting(repository.scanOnPush)}`,
    `    encryption: ${repository.encryptionType}`,
    `    lifecycle policy: ${renderLifecyclePolicy(repository.lifecyclePolicyText, accountId)}`,
  ];

  if (repository.encryptionKey !== undefined) {
    lines.push(
      `    encryption key: ${JSON.stringify(redactAccount(repository.encryptionKey, accountId))}`,
    );
  }
  if (repository.tagMutabilityExclusions.length > 0) {
    lines.push('    mutability exclusion values:');
    for (const exclusion of repository.tagMutabilityExclusions) {
      lines.push(`      ${JSON.stringify(redactAccount(exclusion, accountId))}`);
    }
  }

  lines.push('    tags:');

  const tags = Object.entries(repository.tags).sort(([left], [right]) => left.localeCompare(right));
  if (tags.length === 0) {
    lines.push('      (none)');
  } else {
    for (const [key, value] of tags) {
      lines.push(
        `      ${JSON.stringify(redactAccount(key, accountId))}: ` +
          JSON.stringify(redactAccount(value, accountId)),
      );
    }
  }

  lines.push(`    image digests: ${repository.images.length}`);
  for (const image of repository.images) {
    const tagsText =
      image.tags.length === 0
        ? '(untagged)'
        : image.tags
            .map((tag) => JSON.stringify(redactAccount(tag, accountId)))
            .join(', ');
    lines.push(`      ${image.digest} tags: ${tagsText}`);
  }
  return lines;
}

function renderBooleanSetting(value: boolean | undefined): string {
  return value === undefined ? 'unknown' : value ? 'enabled' : 'disabled';
}

function renderLifecyclePolicy(policyText: string | undefined, accountId: string): string {
  if (policyText === undefined) {
    return '(absent)';
  }
  try {
    return redactAccount(JSON.stringify(JSON.parse(policyText) as unknown), accountId);
  } catch {
    return '(present but invalid JSON)';
  }
}

function renderMessages(heading: string, issues: readonly InspectionIssue<string>[]): string[] {
  if (issues.length === 0) {
    return [];
  }
  return [
    `${heading}:`,
    ...issues.map(({ code, componentId, message }) => {
      const scope = componentId === undefined ? '' : ` [${componentId}]`;
      return `  - [${code}]${scope} ${message}`;
    }),
    '',
  ];
}

function redactAccount(value: string, accountId: string): string {
  return value.replaceAll(accountId, `<account ending ${accountId.slice(-4)}>`);
}
