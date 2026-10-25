import { z } from 'zod';

import {
  retiredControlsSchema,
  sandboxRecordSchema,
  type RetiredControlResource,
  type RetiredControls,
  type SandboxRecord,
} from './sandbox-record';

/** Bounds the error text when a badly broken file produces many issues. */
const MAX_REPORTED_ISSUES = 5;

/** Where a control-stack manifest must have come from. */
export interface ControlStackLocation {
  readonly accountId: string;
  readonly region: string;
  readonly stackName: string;
}

/**
 * Validates untrusted JSON (for example, a record read from disk) and returns
 * a typed, frozen copy. TypeScript types alone cannot do this: they vanish at
 * runtime.
 *
 * @throws Error listing the first few problems, each prefixed with its field
 *   path. Unknown keys are reported as `contains unknown key`.
 */
export function parseSandboxRecord(value: unknown): SandboxRecord {
  const record = parseWith(sandboxRecordSchema, value, 'record');

  if (record.account.accountId === record.managementAccountId) {
    throw new Error('sandbox account must differ from management account');
  }

  const manifest = record.inventory.retiredControls;

  if (manifest !== undefined) {
    const { accountId } = record.account;
    const stackName = record.inventory.controlStackName;

    if (accountId === undefined || stackName === undefined) {
      throw new Error('Control manifest needs exact account and stack');
    }

    assertManifestLocation(manifest, { accountId, region: record.region, stackName });
  }

  return record;
}

/**
 * Validates a retired-controls manifest and checks that it belongs to the
 * given account, region and control stack. A manifest copied from another
 * account or stack is rejected rather than used for cleanup.
 *
 * @param location - named fields, so the three IDs cannot be passed in the wrong order
 * @throws Error when the shape is invalid or any ARN does not match the location
 */
export function parseRetiredControls(
  value: unknown,
  location: ControlStackLocation,
): RetiredControls {
  const manifest = parseWith(retiredControlsSchema, value, 'retiredControls');

  assertManifestLocation(manifest, location);

  return manifest;
}

function assertManifestLocation(manifest: RetiredControls, location: ControlStackLocation): void {
  const { accountId, region, stackName } = location;

  const stackArnPattern = new RegExp(
    `^arn:aws:cloudformation:${region}:${accountId}:stack/${stackName}/[A-Za-z0-9-]+$`,
  );

  if (!stackArnPattern.test(manifest.stackId)) {
    throw new Error('retiredControls.stackId does not match the control stack');
  }

  const seenArns = new Set<string>();

  for (const resource of manifest.resources) {
    const expectedArn = expectedResourceArn(resource, location);

    if (resource.arn !== expectedArn || seenArns.has(expectedArn)) {
      throw new Error('Control manifest identity mismatch or duplicate');
    }

    seenArns.add(expectedArn);
  }
}

function expectedResourceArn(
  resource: RetiredControlResource,
  location: ControlStackLocation,
): string {
  const { accountId, region } = location;

  switch (resource.resourceClass) {
    case 'AWS::DynamoDB::Table':
      return `arn:aws:dynamodb:${region}:${accountId}:table/${resource.physicalId}`;
    case 'AWS::S3::Bucket':
      return `arn:aws:s3:::${resource.physicalId}`;
    case 'AWS::Logs::LogGroup':
      return `arn:aws:logs:${region}:${accountId}:log-group:${resource.physicalId}`;
  }
}

function parseWith<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  rootLabel: string,
): z.output<Schema> {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new Error(describeIssues(result.error, rootLabel));
  }

  return result.data;
}

/**
 * Turns zod issues into one message such as
 * `account contains unknown key token; account.state: Invalid option ...`.
 * Unknown keys come first, so a stray `credentials` or `token` field is always
 * named even when the message is truncated. Messages name fields, never their
 * values, so secrets pasted into the wrong field are not echoed into logs.
 */
function describeIssues(error: z.ZodError, rootLabel: string): string {
  const unknownKeyIssues = error.issues.filter((issue) => issue.code === 'unrecognized_keys');
  const otherIssues = error.issues.filter((issue) => issue.code !== 'unrecognized_keys');
  const ordered = [...unknownKeyIssues, ...otherIssues];

  const reported = ordered.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : rootLabel;

    if (issue.code === 'unrecognized_keys') {
      return `${path} contains unknown key ${issue.keys.join(', ')}`;
    }

    return `${path}: ${issue.message}`;
  });

  const hidden = error.issues.length - reported.length;
  const suffix = hidden > 0 ? `; and ${hidden} more` : '';

  return `${reported.join('; ')}${suffix}`;
}
