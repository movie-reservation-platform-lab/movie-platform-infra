import { chmodSync, readFileSync, symlinkSync } from 'node:fs';
import * as path from 'node:path';
import {
  EXPECTED_ACCOUNT_ID,
  EXPECTED_ROLE_NAME,
  VALID_TARGET_VALUE,
  createFixture,
  expectPrivateValuesAbsent,
  expectSuccessfulRedactedResult,
  runFixturePreflight,
  serializeTarget,
} from './test-support';

test('uses the XDG target path when no explicit override is set', () => {
  const fixture = createFixture();

  try {
    const result = runFixturePreflight(fixture, {
      MOVIE_PLATFORM_AWS_TARGET_FILE: undefined,
      XDG_CONFIG_HOME: fixture.configRoot,
    });

    expectSuccessfulRedactedResult(result);
  } finally {
    fixture.cleanup();
  }
});

test.each([
  ['invalid JSON', '{', 'must contain valid JSON'],
  ['non-object JSON', '[]\n', 'must contain one JSON object'],
  [
    'missing key',
    serializeTarget({
      profile: VALID_TARGET_VALUE.profile,
      region: VALID_TARGET_VALUE.region,
      expectedRoleName: VALID_TARGET_VALUE.expectedRoleName,
    }),
    'missing accountId',
  ],
  [
    'unknown key',
    serializeTarget({ ...VALID_TARGET_VALUE, extra: 'not-allowed' }),
    'contains an unknown key',
  ],
  [
    'non-string profile',
    serializeTarget({ ...VALID_TARGET_VALUE, profile: 42 }),
    'profile must be a string',
  ],
  [
    'wrong Region',
    serializeTarget({ ...VALID_TARGET_VALUE, region: 'us-east-1' }),
    'region must be eu-central-1',
  ],
  [
    'invalid account',
    serializeTarget({ ...VALID_TARGET_VALUE, accountId: '1111' }),
    'accountId must contain exactly 12 digits',
  ],
  [
    'incomplete generated role',
    serializeTarget({
      ...VALID_TARGET_VALUE,
      expectedRoleName: 'AWSReservedSSO_AdministratorAccess',
    }),
    'expectedRoleName must be an exact generated IAM Identity Center role name',
  ],
])('rejects a target file with %s before invoking AWS', (_caseName, contents, message) => {
  const fixture = createFixture(contents);

  try {
    const result = runFixturePreflight(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(readFileSync(fixture.awsMarker, 'utf8')).toBe('');
    expectPrivateValuesAbsent(result);
  } finally {
    fixture.cleanup();
  }
});

test('requires an absolute path for the target-file override', () => {
  const fixture = createFixture();

  try {
    const result = runFixturePreflight(fixture, {
      MOVIE_PLATFORM_AWS_TARGET_FILE: 'relative/aws-target.json',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be an absolute path');
    expect(readFileSync(fixture.awsMarker, 'utf8')).toBe('');
  } finally {
    fixture.cleanup();
  }
});

test('rejects target files readable by group or other users', () => {
  const fixture = createFixture();
  chmodSync(fixture.targetFile, 0o640);

  try {
    const result = runFixturePreflight(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('deny all group and other access');
    expect(readFileSync(fixture.awsMarker, 'utf8')).toBe('');
  } finally {
    fixture.cleanup();
  }
});

test('rejects a symbolic-link target before reading it', () => {
  const fixture = createFixture();
  const linkPath = path.join(fixture.directory, 'linked-target.json');
  symlinkSync(fixture.targetFile, linkPath);

  try {
    const result = runFixturePreflight(fixture, {
      MOVIE_PLATFORM_AWS_TARGET_FILE: linkPath,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must not be a symbolic link');
    expect(readFileSync(fixture.awsMarker, 'utf8')).toBe('');
  } finally {
    fixture.cleanup();
  }
});

test('accepts the complete JSON target shape as strings', () => {
  const fixture = createFixture(
    serializeTarget({
      profile: 'movie-platform-demo',
      region: 'eu-central-1',
      accountId: EXPECTED_ACCOUNT_ID,
      expectedRoleName: EXPECTED_ROLE_NAME,
    }),
  );

  try {
    expectSuccessfulRedactedResult(runFixturePreflight(fixture));
  } finally {
    fixture.cleanup();
  }
});
