/**
 * Captures, finalizes and verifies the control stack's leftovers, the last step before
 * the sandbox account is closed.
 *
 * - `capture-controls`, before the control stack is deleted: records every resource that
 *   can outlive it, with the template's digest.
 * - `finalize-controls`, after deletion: proves the captured stack is the deleted one and
 *   unchanged, deletes what is left, and records each resource confirmed absent.
 * - before closure: verifies again that every captured resource is gone.
 *
 * The rules live in `control-manifest.ts`; this file fetches the data from AWS.
 */

import type { ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';
import {
  parseRetiredControls,
  type RetiredControlResource,
  type RetiredControls,
  type SandboxRecord,
} from '@movie-platform/experiment-sandbox';

import {
  controlTemplateSchema,
  describeStacksResponseSchema,
  getTemplateResponseSchema,
  parseAwsResponse,
  stackResourcePageSchema,
  stackSummaryPageSchema,
} from './aws-responses';
import { nextTokenArgs, readAllPages, type AwsRunner } from './aws-runner';
import { isControlResourceAbsent } from './control-absence';
import {
  assertMatchesCapture,
  retainedControlResources,
  skippedUnlistedDeletion,
  templateDigest,
  type DeployedResource,
  type TemplateResource,
} from './control-manifest';
import { sandboxAccountId } from './operator-access';
import { deleteVersionedBucket } from './versioned-bucket';

/** Control stack states in which the deployed template is final. */
const STABLE_STACK_STATUSES = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);

/** A stack's deployed template: the full body for its digest, and its validated resources. */
interface ControlTemplate {
  /** The whole template as AWS returned it; the digest covers every field. */
  readonly body: unknown;
  readonly resources: Readonly<Record<string, TemplateResource>>;
}

/**
 * Records every control stack resource that can survive the stack's deletion.
 *
 * @throws Error when a manifest already exists, the stack is not stable, or the
 *   template contains a resource type the rules do not know
 */
export function captureControls(
  record: SandboxRecord,
  access: ValidatedAwsAccess,
  run: AwsRunner,
  now: Date,
): RetiredControls {
  if (record.inventory.retiredControls) {
    throw new Error('Control manifest already captured; do not overwrite recovery inventory');
  }

  const stackName = record.inventory.controlStackName;

  if (!stackName || record.account.state !== 'ready') {
    throw new Error('Ready exact control stack required for capture');
  }

  const stackId = readStableStackId(run, access, stackName);
  const controlTemplate = readTemplate(run, access, stackId);
  const deployedResources = readStackResources(run, access, stackId);
  const location = { accountId: sandboxAccountId(record), region: record.region };

  const manifest = {
    stackId,
    capturedAt: now.toISOString(),
    templateSha256: templateDigest(controlTemplate.body),
    resources: retainedControlResources(controlTemplate.resources, deployedResources, location),
  };

  return parseRetiredControls(manifest, { ...location, stackName });
}

/**
 * Deletes the captured resources that still exist and records each one confirmed absent.
 * `verifiedAbsentAt` is set only when every resource is gone; repeat until it is.
 *
 * @throws Error when workload cleanup is unverified or the captured stack cannot be
 *   proven deleted and unchanged
 */
export function finalizeControls(
  record: SandboxRecord,
  access: ValidatedAwsAccess,
  run: AwsRunner,
  now: Date,
): RetiredControls {
  const { inventory } = record;

  if (!inventory.workloadsRemoved || !inventory.accessRevoked || inventory.resources.length > 0) {
    throw new Error(
      'Observed workload cleanup and exported evidence required before finalizing controls',
    );
  }

  const manifest = verifiedDeletedManifest(record, access, run);
  const accountId = sandboxAccountId(record);
  const observedAt = now.toISOString();

  const resources = manifest.resources.map((resource) => {
    if (!isControlResourceAbsent(run, access, resource, accountId)) {
      deleteControlResource(run, access, resource, accountId);
    }

    const { absentObservedAt: _previous, ...identity } = resource;
    const isAbsent = isControlResourceAbsent(run, access, resource, accountId);

    return isAbsent ? { ...identity, absentObservedAt: observedAt } : identity;
  });

  const everyResourceAbsent = resources.every((resource) => 'absentObservedAt' in resource);

  return { ...manifest, resources, verifiedAbsentAt: everyResourceAbsent ? observedAt : undefined };
}

/**
 * Checks, read-only, that the captured stack is deleted and every captured resource is gone.
 *
 * @throws Error naming the first resource that still exists
 */
export async function verifyControlsAbsent(
  record: SandboxRecord,
  access: ValidatedAwsAccess,
  run: AwsRunner,
): Promise<void> {
  const manifest = verifiedDeletedManifest(record, access, run);
  const accountId = sandboxAccountId(record);

  for (const resource of manifest.resources) {
    if (!isControlResourceAbsent(run, access, resource, accountId)) {
      throw new Error(`Protected control ${resource.resourceClass} remains; run finalize-controls`);
    }
  }
}

/** The record's validated manifest, bound to its account, region and control stack. */
function recordedManifest(record: SandboxRecord): RetiredControls {
  const { controlStackName, retiredControls } = record.inventory;

  if (!controlStackName || !record.account.accountId || !retiredControls) {
    throw new Error(
      'Captured control manifest required before stack deletion; unknown or unlisted legacy retained controls block retirement',
    );
  }

  return parseRetiredControls(retiredControls, {
    accountId: record.account.accountId,
    region: record.region,
    stackName: controlStackName,
  });
}

/**
 * The record's manifest, after proving that its stack is deleted, no replacement stack
 * exists, the template is unchanged, and the retained resources are the captured ones.
 */
function verifiedDeletedManifest(
  record: SandboxRecord,
  access: ValidatedAwsAccess,
  run: AwsRunner,
): RetiredControls {
  const manifest = recordedManifest(record);

  assertCapturedStackDeleted(run, access, manifest, record.inventory.controlStackName);

  const template = readTemplate(run, access, manifest.stackId);

  if (templateDigest(template.body) !== manifest.templateSha256) {
    throw new Error(
      'Control template changed after capture; unlisted retained resources may exist',
    );
  }

  const deployed = readStackResources(run, access, manifest.stackId);

  if (skippedUnlistedDeletion(deployed)) {
    throw new Error('Unlisted retained control resource blocks retirement');
  }

  const location = { accountId: sandboxAccountId(record), region: record.region };

  assertMatchesCapture(manifest, retainedControlResources(template.resources, deployed, location));

  return manifest;
}

/** The captured stack shows as `DELETE_COMPLETE`, and no live stack reuses its name. */
function assertCapturedStackDeleted(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  manifest: RetiredControls,
  stackName: string | undefined,
): void {
  const pages = readAllPages(
    (nextToken) =>
      parseAwsResponse(
        stackSummaryPageSchema,
        run(access, [
          'cloudformation',
          'list-stacks',
          '--no-paginate',
          ...nextTokenArgs(nextToken),
        ]),
        'list-stacks',
      ),
    (page) => page.NextToken || undefined,
    'Deleted captured control stack identity cannot be verified',
  );

  const stacks = pages.flatMap((page) => page.StackSummaries);

  const replacementExists = stacks.some(
    (stack) =>
      stack.StackName === stackName &&
      stack.StackId !== manifest.stackId &&
      stack.StackStatus !== 'DELETE_COMPLETE',
  );

  if (replacementExists) {
    throw new Error('Replacement control stack exists; retirement blocked');
  }

  const captured = stacks.find((stack) => stack.StackId === manifest.stackId);

  if (!captured) {
    throw new Error('Deleted captured control stack identity cannot be verified');
  }

  if (captured.StackStatus !== 'DELETE_COMPLETE') {
    throw new Error('Captured control stack is not deleted');
  }
}

function deleteControlResource(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  resource: RetiredControlResource,
  accountId: string,
): void {
  switch (resource.resourceClass) {
    case 'AWS::DynamoDB::Table':
      run(access, ['dynamodb', 'delete-table', '--table-name', resource.physicalId]);

      return;
    case 'AWS::S3::Bucket':
      deleteVersionedBucket(run, access, resource.physicalId, accountId);

      return;
    case 'AWS::Logs::LogGroup':
      run(access, ['logs', 'delete-log-group', '--log-group-name', resource.physicalId]);
  }
}

/** The stack's ID, after checking it exists once and is in a stable state. */
function readStableStackId(run: AwsRunner, access: ValidatedAwsAccess, stackName: string): string {
  const { Stacks } = parseAwsResponse(
    describeStacksResponseSchema,
    run(access, ['cloudformation', 'describe-stacks', '--stack-name', stackName]),
    'describe-stacks',
  );

  if (Stacks.length !== 1) {
    throw new Error('Exact control stack required');
  }

  const [stack] = Stacks;

  if (!STABLE_STACK_STATUSES.has(stack.StackStatus) || !stack.StackId) {
    throw new Error('Stable deployed control stack required before capture');
  }

  return stack.StackId;
}

/** The stack's original template, as deployed. */
function readTemplate(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  stackId: string,
): ControlTemplate {
  const { TemplateBody } = parseAwsResponse(
    getTemplateResponseSchema,
    run(access, [
      'cloudformation',
      'get-template',
      '--stack-name',
      stackId,
      '--template-stage',
      'Original',
    ]),
    'get-template',
  );

  let body: unknown = TemplateBody;

  if (typeof TemplateBody === 'string') {
    try {
      body = JSON.parse(TemplateBody) as unknown;
    } catch {
      throw new Error('Control template must be verifiable JSON');
    }
  }

  const { Resources } = parseAwsResponse(controlTemplateSchema, body, 'get-template');

  return { body, resources: Resources };
}

/** Every resource of the stack, as CloudFormation reports it. */
function readStackResources(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  stackId: string,
): DeployedResource[] {
  const pages = readAllPages(
    (nextToken) =>
      parseAwsResponse(
        stackResourcePageSchema,
        run(access, [
          'cloudformation',
          'list-stack-resources',
          '--stack-name',
          stackId,
          '--no-paginate',
          ...nextTokenArgs(nextToken),
        ]),
        'list-stack-resources',
      ),
    (page) => page.NextToken || undefined,
    'Control resource capture exceeded ten pages; cannot prove complete inventory',
  );

  return pages.flatMap((page) => page.StackResourceSummaries);
}
