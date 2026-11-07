import { validateAwsAccess } from '@movie-platform/aws-account-preflight';
import { AwsCliSandboxCloud, type AwsRunner } from '../src/aws-cli';
import { reconcileAccount } from '../src/lifecycle';
import { sampleRecord } from '../src/sample';
import type { ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';

jest.mock('@movie-platform/aws-account-preflight', () => ({ validateAwsAccess: jest.fn() }));
const preflight = jest.mocked(validateAwsAccess);

beforeEach(() =>
  preflight.mockReturnValue({
    target: {
      profile: 'sandbox',
      accountId: '111111111111',
      region: 'eu-central-1',
      expectedRoleName: 'AWSReservedSSO_Operator_0123456789abcdef',
    },
    permissionSet: 'Operator',
    configFiles: { configFilepath: '/private/config', credentialsFilepath: '/private/credentials' },
  }),
);

test('operator create calls fixed CLI arguments only after exact target preflight', async () => {
  const run = jest.fn<ReturnType<AwsRunner>, Parameters<AwsRunner>>().mockReturnValue({
    CreateAccountStatus: {
      Id: 'car-example0001',
      AccountName: 'exp-harness-buy-check-example0001',
      State: 'IN_PROGRESS',
    },
  });

  const record = sampleRecord(new Date());

  expect(await new AwsCliSandboxCloud(run).create(record)).toEqual({
    state: 'requested',
    requestId: 'car-example0001',
  });

  expect(preflight).toHaveBeenCalledWith(
    expect.objectContaining({ MOVIE_PLATFORM_AWS_TARGET_FILE: record.managementTargetFile }),
  );

  expect(run.mock.calls[0][1]).toContain('DENY');

  expect(run.mock.calls[0][1]).toContain(
    `Key=ExperimentCorrelation,Value=${record.account.correlationId}`,
  );
});

test('wrong preflight target fails before account request', async () => {
  const wrong = {
    ...preflight({}),
    target: { ...preflight({}).target, accountId: '999999999999' },
  } as ValidatedAwsAccess;

  preflight.mockReturnValue(wrong);
  const run = jest.fn();

  await expect(new AwsCliSandboxCloud(run).create(sampleRecord(new Date()))).rejects.toThrow(
    /exact record/,
  );

  expect(run).not.toHaveBeenCalled();
});

test('unknown submission reconciles unique existing correlation and never creates a replacement', async () => {
  const run = jest.fn<ReturnType<AwsRunner>, Parameters<AwsRunner>>().mockReturnValue({
    CreateAccountStatuses: [
      {
        AccountName: 'exp-harness-buy-check-example0001',
        Id: 'car-example0001',
        State: 'SUCCEEDED',
        AccountId: '222222222222',
      },
    ],
  });

  expect(
    await new AwsCliSandboxCloud(run).reconcile({
      ...sampleRecord(new Date()),
      account: { ...sampleRecord(new Date()).account, state: 'unknown' },
    }),
  ).toEqual({ state: 'ready', requestId: 'car-example0001', accountId: '222222222222' });

  expect(run.mock.calls[0][1][1]).toBe('list-create-account-status');
  expect(run.mock.calls.flat().join(' ')).not.toContain('create-account --');
});

test('ambiguous matching requests fail closed', async () => {
  const status = {
    AccountName: 'exp-harness-buy-check-example0001',
    Id: 'car-example0001',
    State: 'IN_PROGRESS',
  };

  const run = jest
    .fn<ReturnType<AwsRunner>, Parameters<AwsRunner>>()
    .mockReturnValue({ CreateAccountStatuses: [status, status] });

  await expect(new AwsCliSandboxCloud(run).reconcile(sampleRecord(new Date()))).rejects.toThrow(
    /ambiguous/,
  );
});

test('lease initialization requires matching cleanup schedule and confirmed alert route, then writes only once conditionally', async () => {
  const base = sampleRecord(new Date());

  const record = {
    ...base,
    sandboxTargetFile: '/private/sandbox.json',
    account: { ...base.account, accountId: '222222222222', state: 'ready' as const },
    inventory: {
      ...base.inventory,
      controlStackName: 'trial-control',
      stackName: 'trial-workload',
    },
  };

  preflight.mockReturnValue({
    ...preflight({}),
    target: { ...preflight({}).target, accountId: '222222222222' },
  });

  const cleanupArn = 'arn:aws:lambda:eu-central-1:222222222222:function:trial-cleanup';

  const outputs = {
    ExperimentId: record.id,
    WorkloadStackName: 'trial-workload',
    StateTableName: 'protected-table',
    CleanupArn: cleanupArn,
    CleanupScheduleName: 'cleanup-timer',
    CleanupAlertTopicArn: 'arn:aws:sns:eu-central-1:222222222222:alerts',
  };

  const run = jest
    .fn<ReturnType<AwsRunner>, Parameters<AwsRunner>>()
    .mockImplementation((_access, args) => {
      if (args[0] === 'cloudformation') {
        return {
          Stacks: [
            {
              StackStatus: 'CREATE_COMPLETE',
              Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({
                OutputKey,
                OutputValue,
              })),
            },
          ],
        };
      }

      if (args[1] === 'describe-rule') {
        return { State: 'ENABLED' };
      }

      if (args[1] === 'list-targets-by-rule') {
        return {
          Targets: [
            {
              Arn: cleanupArn,
              Input: JSON.stringify({ experimentId: record.id, scheduled: true }),
            },
          ],
        };
      }

      if (args[0] === 'sns') {
        return {
          Subscriptions: [
            { SubscriptionArn: 'arn:aws:sns:eu-central-1:222222222222:alerts:confirmed' },
          ],
        };
      }

      return {};
    });

  await new AwsCliSandboxCloud(run).admit(record);

  expect(run.mock.calls.at(-1)?.[1]).toEqual(
    expect.arrayContaining([
      'put-item',
      '--condition-expression',
      'attribute_not_exists(experimentId)',
    ]),
  );

  expect(run.mock.calls.at(-1)?.[1].join(' ')).toContain(record.lease.rejectNewWorkAt);
});

test.each([
  {
    Id: 'car-other0001',
    AccountName: 'exp-harness-buy-check-example0001',
    AccountId: '222222222222',
  },
  { Id: 'car-example0001', AccountName: 'different-account', AccountId: '222222222222' },
  {
    Id: 'car-example0001',
    AccountName: 'exp-harness-buy-check-example0001',
    AccountId: '333333333333',
  },
])(
  'reconciliation mismatch rejects and never persists modified account identity: %j',
  async (response) => {
    const base = sampleRecord(new Date());

    const record = {
      ...base,
      account: {
        ...base.account,
        state: 'ready' as const,
        requestId: 'car-example0001',
        accountId: '222222222222',
      },
    };

    const before = structuredClone(record);
    const save = jest.fn();

    const run = jest
      .fn<ReturnType<AwsRunner>, Parameters<AwsRunner>>()
      .mockReturnValue({ CreateAccountStatus: { ...response, State: 'SUCCEEDED' } });

    await expect(reconcileAccount(record, { save }, new AwsCliSandboxCloud(run))).rejects.toThrow(
      /mismatch|identity/,
    );

    expect(save).not.toHaveBeenCalled();
    expect(record).toEqual(before);
  },
);
