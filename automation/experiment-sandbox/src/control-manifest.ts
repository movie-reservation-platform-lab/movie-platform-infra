/**
 * Rules for the control manifest: which control stack resources can outlive the stack,
 * how they are identified, and whether a later look still matches what was captured.
 *
 * Pure decisions over template and stack data; `control-inventory.ts` fetches that data
 * from AWS and calls these functions.
 */

import { createHash } from 'node:crypto';

import type { RetiredControlResource, RetiredControls } from '@movie-platform/experiment-sandbox';

/** Resource types that keep data and can survive stack deletion; each is captured. */
const RETAINED_CONTROL_TYPES = new Set<string>([
  'AWS::DynamoDB::Table',
  'AWS::S3::Bucket',
  'AWS::Logs::LogGroup',
]);

/**
 * Resource types the control stack may contain that hold no data after deletion. Any
 * other type blocks capture, so a new kind of resource is reviewed before it can hide.
 */
const STATELESS_CONTROL_TYPES = new Set<string>([
  'AWS::S3::BucketPolicy',
  'Custom::S3AutoDeleteObjects',
  'AWS::IAM::Role',
  'AWS::IAM::Policy',
  'AWS::Lambda::Function',
  'AWS::Lambda::Permission',
  'AWS::Events::Rule',
  'AWS::SNS::Topic',
  'AWS::SNS::TopicPolicy',
  'AWS::CloudWatch::Alarm',
  'AWS::Logs::MetricFilter',
  'AWS::CDK::Metadata',
]);

/** CloudFormation policies that keep a resource when the stack deletes or replaces it. */
const RETAIN_POLICIES = new Set(['Retain', 'Snapshot', 'RetainExceptOnCreate']);

/** A resource as the stack template declares it. */
export interface TemplateResource {
  readonly Type: string;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}

/** A resource as CloudFormation reports it for a deployed or deleted stack. */
export interface DeployedResource {
  readonly LogicalResourceId: string;
  readonly ResourceType: string;
  readonly PhysicalResourceId?: string;
  readonly ResourceStatus?: string;
}

/** The account and region a manifest's ARNs belong to. */
export interface ManifestLocation {
  readonly accountId: string;
  readonly region: string;
}

/**
 * A stable fingerprint of a template: SHA-256 of its JSON with object keys sorted, so the
 * same template always gives the same digest, whatever order AWS returns keys in.
 */
export function templateDigest(template: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(withSortedKeys(template)))
    .digest('hex');
}

/**
 * The resources that can outlive the control stack: every table, bucket and log group,
 * plus the default log group each Lambda function may create outside CloudFormation.
 *
 * @throws Error when the template holds an unknown type, retains an unsupported type,
 *   or a template resource has no single deployed counterpart
 */
export function retainedControlResources(
  templateResources: Readonly<Record<string, TemplateResource>>,
  deployed: readonly DeployedResource[],
  location: ManifestLocation,
): RetiredControlResource[] {
  const resources: RetiredControlResource[] = [];

  for (const [logicalId, definition] of Object.entries(templateResources)) {
    const type = definition.Type;
    const isRetainedType = RETAINED_CONTROL_TYPES.has(type);

    assertKnownControlType(type, definition, isRetainedType);

    if (!isRetainedType && type !== 'AWS::Lambda::Function') {
      continue;
    }

    const physicalId = deployedPhysicalId(deployed, logicalId, type);

    if (isRetainedType) {
      resources.push(controlResource(type, physicalId, logicalId, location));
    } else {
      // Older Lambda functions write to `/aws/lambda/<name>`, which CloudFormation does not own.
      resources.push(
        controlResource(
          'AWS::Logs::LogGroup',
          `/aws/lambda/${physicalId}`,
          `${logicalId}ImplicitLogs`,
          location,
        ),
      );
    }
  }

  return withoutDuplicateArns(resources);
}

/**
 * Whether a deleted stack skipped deleting anything other than a retained type, which
 * would leave a resource the manifest cannot see.
 */
export function skippedUnlistedDeletion(deployed: readonly DeployedResource[]): boolean {
  return deployed.some(
    (resource) =>
      resource.ResourceStatus === 'DELETE_SKIPPED' &&
      !RETAINED_CONTROL_TYPES.has(resource.ResourceType),
  );
}

/**
 * Checks that the resources found now are exactly the captured ones, by ARN and logical ID.
 *
 * @throws Error when a resource was added, removed or changed after capture
 */
export function assertMatchesCapture(
  manifest: RetiredControls,
  current: readonly RetiredControlResource[],
): void {
  const sameResources =
    current.length === manifest.resources.length &&
    current.every((resource) =>
      manifest.resources.some(
        (captured) => captured.arn === resource.arn && captured.logicalId === resource.logicalId,
      ),
    );

  if (!sameResources) {
    throw new Error(
      'Control resources changed after capture; complete manifest cannot be established',
    );
  }
}

function assertKnownControlType(
  type: string,
  definition: TemplateResource,
  isRetainedType: boolean,
): void {
  if (isRetainedType) {
    return;
  }

  const isRetained =
    RETAIN_POLICIES.has(definition.DeletionPolicy ?? '') ||
    RETAIN_POLICIES.has(definition.UpdateReplacePolicy ?? '');

  if (isRetained) {
    throw new Error(`Unknown retained control type ${type} blocks capture`);
  }

  if (!STATELESS_CONTROL_TYPES.has(type)) {
    throw new Error(`Unknown control resource type ${type} blocks capture`);
  }
}

function deployedPhysicalId(
  deployed: readonly DeployedResource[],
  logicalId: string,
  type: string,
): string {
  const matches = deployed.filter(
    (resource) => resource.LogicalResourceId === logicalId && resource.ResourceType === type,
  );

  const physicalId = matches.length === 1 ? matches[0].PhysicalResourceId : undefined;

  if (!physicalId) {
    throw new Error('Unlisted protected control resource blocks capture');
  }

  return physicalId;
}

function controlResource(
  type: string,
  physicalId: string,
  logicalId: string,
  location: ManifestLocation,
): RetiredControlResource {
  const { accountId, region } = location;

  switch (type) {
    case 'AWS::DynamoDB::Table':
      return {
        resourceClass: type,
        physicalId,
        logicalId,
        arn: `arn:aws:dynamodb:${region}:${accountId}:table/${physicalId}`,
      };
    case 'AWS::S3::Bucket':
      return { resourceClass: type, physicalId, logicalId, arn: `arn:aws:s3:::${physicalId}` };
    case 'AWS::Logs::LogGroup':
      return {
        resourceClass: type,
        physicalId,
        logicalId,
        arn: `arn:aws:logs:${region}:${accountId}:log-group:${physicalId}`,
      };
    default:
      throw new Error('Unsupported protected control resource');
  }
}

function withoutDuplicateArns(
  resources: readonly RetiredControlResource[],
): RetiredControlResource[] {
  const seen = new Set<string>();

  return resources.filter((resource) => {
    if (seen.has(resource.arn)) {
      return false;
    }

    seen.add(resource.arn);

    return true;
  });
}

/** A copy of `value` with every object's keys sorted, for a stable JSON form. */
function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withSortedKeys);
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));

    return Object.fromEntries(entries.map(([key, item]) => [key, withSortedKeys(item)]));
  }

  return value;
}
