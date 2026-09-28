import type { ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';
import type { AuditAccountConfig } from '@movie-platform/audit-account-config';
import { runOperatorCli } from '../src/operator-cli';

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

test('reports a redacted preflight result without invoking another process', () => {
  const fixture = createCliFixture();

  expect(fixture.run(['preflight'])).toBe(0);
  expect(fixture.stdout()).toContain('Audit-account preflight passed');
  expect(fixture.stdout()).toContain('account last four: 2222');
  expect(fixture.stdout()).not.toContain(config.auditAccountId);
  expect(fixture.runProcess).not.toHaveBeenCalled();
});

test('queries only the CDK bootstrap stack after the audit target passes preflight', () => {
  const fixture = createCliFixture({ status: 0, stdout: 'CREATE_COMPLETE\n' });

  expect(fixture.run(['status'])).toBe(0);
  expect(fixture.stdout()).toBe('Audit-account CDK bootstrap status: CREATE_COMPLETE\n');
  expect(fixture.runProcess).toHaveBeenCalledWith(
    'aws',
    expect.arrayContaining([
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      'CDKToolkit',
      '--profile',
      'movie-platform-audit',
      '--region',
      'eu-central-1',
    ]),
    expect.objectContaining({
      AWS_CONFIG_FILE: '/private/aws/config',
      AWS_SHARED_CREDENTIALS_FILE: '/private/aws/credentials',
    }),
  );
});

test('plans bootstrap without executing it unless --execute is explicit', () => {
  const fixture = createCliFixture();

  expect(fixture.run(['bootstrap'])).toBe(0);
  expect(fixture.stdout()).toContain('rerun with --execute');
  expect(fixture.runProcess).not.toHaveBeenCalled();
});

test('blocks status before invoking AWS when the SSO target is another account', () => {
  const fixture = createCliFixture(
    { status: 0, stdout: 'CREATE_COMPLETE\n' },
    {
      ...access,
      target: { ...access.target, accountId: '444444444444' },
    },
  );

  expect(fixture.run(['status'])).toBe(1);
  expect(fixture.stderr()).toContain('does not match the configured audit account');
  expect(fixture.runProcess).not.toHaveBeenCalled();
});

function createCliFixture(
  processResult: { readonly status: number | null; readonly stdout: string } = {
    status: 0,
    stdout: '',
  },
  validatedAccess: ValidatedAwsAccess = access,
) {
  let stdout = '';
  let stderr = '';
  const runProcess = jest.fn(() => processResult);

  return {
    run: (arguments_: readonly string[]) =>
      runOperatorCli(
        arguments_,
        {},
        {
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        },
        {
          loadConfig: () => config,
          validateAccess: () => validatedAccess,
          runProcess,
        },
      ),
    stdout: () => stdout,
    stderr: () => stderr,
    runProcess,
  };
}
