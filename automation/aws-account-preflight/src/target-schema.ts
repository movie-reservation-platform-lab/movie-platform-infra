import { fail } from './preflight-error';

/** @internal */
export const REQUIRED_AWS_REGION = 'eu-central-1' as const;

const TARGET_KEYS = ['profile', 'region', 'accountId', 'expectedRoleName'] as const;

type TargetKey = (typeof TARGET_KEYS)[number];

/**
 * Validated identity and Region pin loaded from the operator-owned target file.
 *
 * @internal
 */
export interface AwsTarget {
  readonly profile: string;
  readonly region: typeof REQUIRED_AWS_REGION;
  readonly accountId: string;
  readonly expectedRoleName: string;
}

/**
 * Parse JSON syntax, then validate the unknown runtime value as an AWS target.
 *
 * `JSON.parse` establishes only that the text is valid JSON. It does not make
 * the result trustworthy or turn it into an {@link AwsTarget}; the explicit
 * object, key, type, and value checks below establish that runtime contract.
 *
 * @param contents - UTF-8 contents of `aws-target.json`.
 * @returns A frozen target whose complete shape and values are validated.
 * @internal
 */
export function parseAwsTargetJson(contents: string): AwsTarget {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    fail('the target file must contain valid JSON');
  }

  return validateAwsTarget(value);
}

function validateAwsTarget(value: unknown): AwsTarget {
  if (!isJsonObject(value)) {
    fail('the target file must contain one JSON object');
  }

  const actualKeys = Object.keys(value);
  const unknownKey = actualKeys.find((key) => !isTargetKey(key));
  if (unknownKey !== undefined) {
    fail('the target file contains an unknown key');
  }

  for (const key of TARGET_KEYS) {
    if (!Object.hasOwn(value, key)) {
      fail(`the target file is missing ${key}`);
    }
  }

  const profile = requireString(value, 'profile');
  const region = requireString(value, 'region');
  const accountId = requireString(value, 'accountId');
  const expectedRoleName = requireString(value, 'expectedRoleName');

  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(profile)) {
    fail('the target profile has an unsupported format');
  }
  if (region !== REQUIRED_AWS_REGION) {
    fail(`the target region must be ${REQUIRED_AWS_REGION}`);
  }
  if (!/^[0-9]{12}$/.test(accountId)) {
    fail('the target accountId must contain exactly 12 digits');
  }
  if (!/^AWSReservedSSO_[A-Za-z0-9+=,.@_-]+_[0-9a-fA-F]{16}$/.test(expectedRoleName)) {
    fail('the target expectedRoleName must be an exact generated IAM Identity Center role name');
  }

  return Object.freeze({ profile, region, accountId, expectedRoleName });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTargetKey(value: string): value is TargetKey {
  return TARGET_KEYS.some((key) => key === value);
}

function requireString(value: Readonly<Record<string, unknown>>, key: TargetKey): string {
  const field = value[key];
  if (typeof field !== 'string') {
    fail(`the target ${key} must be a string`);
  }
  return field;
}
