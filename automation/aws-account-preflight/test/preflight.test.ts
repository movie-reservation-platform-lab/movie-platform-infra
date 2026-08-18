import { readFileSync } from 'node:fs';
import {
  CREDENTIAL_ENVIRONMENT_VARIABLES,
  EXPECTED_ACCOUNT_ID,
  EXPECTED_ROLE_NAME,
  SESSION_NAME,
  createFixture,
  expectPrivateValuesAbsent,
  expectSuccessfulRedactedResult,
  runFixturePreflight,
} from './test-support';

test.each(CREDENTIAL_ENVIRONMENT_VARIABLES)(
  'rejects the %s credential environment variable before invoking AWS',
  (variableName) => {
    const fixture = createFixture();

    try {
      const result = runFixturePreflight(fixture, { [variableName]: 'private-test-value' });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${variableName} must be unset`);
      expect(result.stderr).not.toContain('private-test-value');
      expect(readFileSync(fixture.awsMarker, 'utf8')).toBe('');
    } finally {
      fixture.cleanup();
    }
  },
);

test('requires AWS CLI v2 before reading profile configuration', () => {
  const fixture = createFixture();

  try {
    const result = runFixturePreflight(fixture, { AWS_STUB_VERSION: 'aws-cli/1.42.0' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AWS CLI v2 is required');
    expect(readFileSync(fixture.awsMarker, 'utf8')).toBe('--version\n');
    expect(readFileSync(fixture.stsMarker, 'utf8')).toBe('');
  } finally {
    fixture.cleanup();
  }
});

test.each([
  ['account', { AWS_STUB_PROFILE_ACCOUNT: '222222222222' }, 'profile account does not match'],
  ['Region', { AWS_STUB_PROFILE_REGION: 'us-east-1' }, 'profile Region does not match'],
  [
    'SSO token provider',
    { AWS_STUB_PROFILE_SSO_SESSION: '' },
    'must use the AWS CLI v2 SSO token-provider',
  ],
  ['SSO Region', { AWS_STUB_SSO_REGION: 'us-east-1' }, 'SSO session Region does not match'],
  [
    'permission set',
    { AWS_STUB_PROFILE_PERMISSION_SET: 'PowerUserAccess' },
    'permission set does not match',
  ],
  [
    'profile access key',
    { AWS_STUB_PROFILE_ACCESS_KEY: 'not-a-real-key' },
    'static or cached credentials',
  ],
  [
    'profile session token',
    { AWS_STUB_PROFILE_SESSION_TOKEN: 'not-a-real-token' },
    'static or cached credentials',
  ],
  [
    'credential process',
    { AWS_STUB_PROFILE_CREDENTIAL_PROCESS: '/not/used' },
    'non-SSO credential provider',
  ],
  [
    'role chaining',
    { AWS_STUB_PROFILE_ROLE_ARN: 'arn:aws:iam::111111111111:role/not-used' },
    'non-SSO credential provider',
  ],
  [
    'web identity',
    { AWS_STUB_PROFILE_WEB_IDENTITY_TOKEN_FILE: '/not/used' },
    'non-SSO credential provider',
  ],
  [
    'console login session',
    { AWS_STUB_PROFILE_LOGIN_SESSION: 'not-used' },
    'non-SSO credential provider',
  ],
])('rejects a profile with the wrong %s before calling STS', (_caseName, envOverrides, expectedMessage) => {
  const fixture = createFixture();

  try {
    const result = runFixturePreflight(fixture, envOverrides);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expectedMessage);
    expect(readFileSync(fixture.stsMarker, 'utf8')).toBe('');
    expectPrivateValuesAbsent(result, Object.values(envOverrides));
  } finally {
    fixture.cleanup();
  }
});

test.each([
  [
    'account',
    {
      AWS_STUB_CALLER_ACCOUNT: '222222222222',
      AWS_STUB_CALLER_ARN:
        `arn:aws:sts::222222222222:assumed-role/${EXPECTED_ROLE_NAME}/${SESSION_NAME}`,
    },
    'live caller account does not match',
  ],
  [
    'role',
    {
      AWS_STUB_CALLER_ARN: [
        `arn:aws:sts::${EXPECTED_ACCOUNT_ID}:assumed-role/`,
        `AWSReservedSSO_AdministratorAccess_fedcba9876543210/${SESSION_NAME}`,
      ].join(''),
    },
    'live caller role does not match',
  ],
  [
    'principal type',
    {
      AWS_STUB_CALLER_ARN: `arn:aws:iam::${EXPECTED_ACCOUNT_ID}:user/long-lived-user`,
    },
    'caller is not an IAM Identity Center assumed-role session',
  ],
])('rejects the wrong live caller %s without revealing it', (_caseName, envOverrides, expectedMessage) => {
  const fixture = createFixture();

  try {
    const result = runFixturePreflight(fixture, envOverrides);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expectedMessage);
    expect(readFileSync(fixture.stsMarker, 'utf8')).toContain('sts get-caller-identity');
    expectPrivateValuesAbsent(result, Object.values(envOverrides));
  } finally {
    fixture.cleanup();
  }
});

test('sanitizes an STS failure instead of forwarding AWS CLI diagnostics', () => {
  const fixture = createFixture();

  try {
    const result = runFixturePreflight(fixture, { AWS_STUB_STS_FAILURE: 'true' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('STS GetCallerIdentity failed');
    expect(result.stderr).not.toContain('private AWS CLI diagnostic');
    expectPrivateValuesAbsent(result);
  } finally {
    fixture.cleanup();
  }
});

test('passes only the exact SSO identity and prints the approved redacted fields', () => {
  const fixture = createFixture();

  try {
    const result = runFixturePreflight(fixture);

    expectSuccessfulRedactedResult(result);
    expect(result.stdout).toBe(
      [
        'AWS account preflight passed',
        '  profile: movie-platform-demo',
        '  region: eu-central-1',
        '  permission set: AdministratorAccess',
        '  account last four: 1111',
        '',
      ].join('\n'),
    );

    const stsInvocation = readFileSync(fixture.stsMarker, 'utf8');
    expect(stsInvocation).toContain('sts get-caller-identity');
    expect(stsInvocation).toContain('--profile movie-platform-demo');
    expect(stsInvocation).toContain('--region eu-central-1');
  } finally {
    fixture.cleanup();
  }
});
