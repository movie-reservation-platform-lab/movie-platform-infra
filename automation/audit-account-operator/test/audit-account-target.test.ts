import type { ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';
import type { AuditAccountConfig } from '@movie-platform/audit-account-config';
import { validateAuditAccountTarget } from '../src/audit-account-target';

const config: AuditAccountConfig = {
  managementAccountId: '111111111111',
  auditAccountId: '222222222222',
  workloadAccountIds: ['333333333333'],
  region: 'eu-central-1',
};

const access: ValidatedAwsAccess = {
  target: {
    profile: 'movie-platform-audit',
    region: 'eu-central-1',
    accountId: '222222222222',
    expectedRoleName: 'AWSReservedSSO_AdministratorAccess_0123456789abcdef',
  },
  permissionSet: 'AdministratorAccess',
  configFiles: {
    configFilepath: '/private/aws/config',
    credentialsFilepath: '/private/aws/credentials',
  },
};

test('accepts a validated SSO target for the configured audit account', () => {
  expect(validateAuditAccountTarget(config, access)).toEqual({ config, access });
});

test('rejects a validated SSO target for another account without printing either account ID', () => {
  const wrongAccess: ValidatedAwsAccess = {
    ...access,
    target: { ...access.target, accountId: '444444444444' },
  };

  expect(() => validateAuditAccountTarget(config, wrongAccess)).toThrow(
    'the validated AWS target does not match the configured audit account',
  );
  try {
    validateAuditAccountTarget(config, wrongAccess);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain(config.auditAccountId);
    expect(message).not.toContain(wrongAccess.target.accountId);
  }
});
