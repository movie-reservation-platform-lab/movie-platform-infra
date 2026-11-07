import { validateAwsAccess } from '@movie-platform/aws-account-preflight';
import { AwsCliSandboxCloud, type AwsRunner } from '../src/aws-cli';
import { AwsOperationError } from '../src/aws-error';
import { sampleRecord } from '../src/sample';
import { parseSandboxRecord, type SandboxRecord } from '@movie-platform/experiment-sandbox';

jest.mock('@movie-platform/aws-account-preflight', () => ({ validateAwsAccess: jest.fn() }));
const accountId = '222222222222';
const now = new Date('2026-10-24T12:00:00Z');
const stackId = `arn:aws:cloudformation:eu-central-1:${accountId}:stack/trial-control/unique`;

const template = {
  Resources: {
    State: { Type: 'AWS::DynamoDB::Table', DeletionPolicy: 'Retain' },
    Inventory: { Type: 'AWS::S3::Bucket', DeletionPolicy: 'Retain' },
    Logs: { Type: 'AWS::Logs::LogGroup', DeletionPolicy: 'Retain' },
    Provider: { Type: 'AWS::Lambda::Function' },
  },
};

const actual = [
  {
    LogicalResourceId: 'State',
    ResourceType: 'AWS::DynamoDB::Table',
    PhysicalResourceId: 'protected-table',
  },
  {
    LogicalResourceId: 'Inventory',
    ResourceType: 'AWS::S3::Bucket',
    PhysicalResourceId: 'protected-bucket',
  },
  {
    LogicalResourceId: 'Logs',
    ResourceType: 'AWS::Logs::LogGroup',
    PhysicalResourceId: '/experiment/protected',
  },
  {
    LogicalResourceId: 'Provider',
    ResourceType: 'AWS::Lambda::Function',
    PhysicalResourceId: 'protected-provider',
  },
];

function record(): SandboxRecord {
  const base = sampleRecord(now);

  return {
    ...base,
    sandboxTargetFile: '/private/sandbox.json',
    account: { ...base.account, state: 'ready', accountId },
    inventory: {
      ...base.inventory,
      controlStackName: 'trial-control',
      stackName: 'trial-workload',
      workloadsRemoved: true,
      accessRevoked: true,
      observedAt: now.toISOString(),
    },
  };
}

function fake() {
  let stackStatus = 'CREATE_COMPLETE';
  let table = false;
  let bucket = false;
  let logs = false;
  let implicitLogs = false;
  let versions = true;
  let uploads = true;

  const run = jest
    .fn<ReturnType<AwsRunner>, Parameters<AwsRunner>>()
    .mockImplementation((_access, args) => {
      const operation = args[1];

      if (operation === 'describe-stacks') {
        return { Stacks: [{ StackId: stackId, StackStatus: stackStatus }] };
      }

      if (operation === 'get-template') {
        return { TemplateBody: template };
      }

      if (operation === 'list-stack-resources') {
        return { StackResourceSummaries: actual };
      }

      if (operation === 'list-stacks') {
        return {
          StackSummaries: [
            { StackId: stackId, StackName: 'trial-control', StackStatus: stackStatus },
          ],
        };
      }

      if (operation === 'describe-table') {
        if (!table) {
          throw new AwsOperationError('ResourceNotFoundException');
        }

        return {
          Table: { TableArn: `arn:aws:dynamodb:eu-central-1:${accountId}:table/protected-table` },
        };
      }

      if (operation === 'delete-table') {
        table = false;

        return {};
      }

      if (operation === 'head-bucket') {
        if (!bucket) {
          throw new AwsOperationError('404');
        }

        return {};
      }

      if (operation === 'list-object-versions') {
        return versions
          ? {
              Versions: [{ Key: 'evidence.json', VersionId: 'v1' }],
              DeleteMarkers: [{ Key: 'evidence.json', VersionId: 'v2' }],
              IsTruncated: false,
            }
          : { IsTruncated: false };
      }

      if (operation === 'delete-objects') {
        versions = false;

        return {};
      }

      if (operation === 'list-multipart-uploads') {
        return uploads ? { Uploads: [{ Key: 'upload', UploadId: 'upload1' }] } : {};
      }

      if (operation === 'abort-multipart-upload') {
        uploads = false;

        return {};
      }

      if (operation === 'delete-bucket') {
        bucket = false;

        return {};
      }

      if (operation === 'describe-log-groups') {
        const name = args[args.indexOf('--log-group-name-prefix') + 1];

        return {
          logGroups: (name === '/experiment/protected' ? logs : implicitLogs)
            ? [{ logGroupName: name }]
            : [],
        };
      }

      if (operation === 'delete-log-group') {
        if (args.includes('/experiment/protected')) {
          logs = false;
        } else {
          implicitLogs = false;
        }

        return {};
      }

      if (operation === 'close-account') {
        return {};
      }

      throw new Error(`Unexpected fake operation ${operation}`);
    });

  return {
    run,
    setDeleted: () => {
      stackStatus = 'DELETE_COMPLETE';
    },
    setRemaining: (kind: string) => {
      table = kind === 'table';
      bucket = kind === 'bucket';
      logs = kind === 'logs';
      implicitLogs = kind === 'implicit';
    },
    setAll: () => {
      table = bucket = logs = implicitLogs = true;
    },
  };
}

beforeEach(() =>
  jest.mocked(validateAwsAccess).mockImplementation((env) => ({
    target: {
      profile: 'operator',
      accountId:
        env.MOVIE_PLATFORM_AWS_TARGET_FILE === record().managementTargetFile
          ? '111111111111'
          : accountId,
      region: 'eu-central-1',
      expectedRoleName: 'AWSReservedSSO_Operator_0123456789abcdef',
    },
    permissionSet: 'Operator',
    configFiles: {
      configFilepath: '/private/config',
      credentialsFilepath: '/private/credentials',
    },
  })),
);

test.each(['table', 'bucket', 'logs', 'implicit'])(
  'deleted stack plus remaining %s never permits closure',
  async (kind) => {
    const aws = fake();
    const cloud = new AwsCliSandboxCloud(aws.run);
    const base = record();
    const retiredControls = await cloud.captureControls(base, now);
    const captured = { ...base, inventory: { ...base.inventory, retiredControls } };

    expect(retiredControls.resources).toHaveLength(4);

    aws.setDeleted();
    aws.setRemaining(kind);

    // retireAccount runs this check before any closure request; it must refuse.
    await expect(cloud.verifyRetirement(captured)).rejects.toThrow(/remains/);
    expect(aws.run.mock.calls.some(([, args]) => args[1] === 'close-account')).toBe(false);
  },
);

test('finalize deletes exact captured legacy versions, delete markers, multipart uploads and logs, then verifies each absent', async () => {
  const aws = fake();
  const cloud = new AwsCliSandboxCloud(aws.run);
  const base = record();

  const captured = {
    ...base,
    inventory: { ...base.inventory, retiredControls: await cloud.captureControls(base, now) },
  };

  aws.setDeleted();
  aws.setAll();
  const manifest = await cloud.finalizeControls(captured, now);

  expect(manifest.verifiedAbsentAt).toBe(now.toISOString());
  expect(manifest.resources.every((item) => item.absentObservedAt)).toBe(true);

  const deletion = aws.run.mock.calls.find(([, args]) => args[1] === 'delete-objects')?.[1];

  expect(deletion?.join(' ')).toContain('v1');
  expect(deletion?.join(' ')).toContain('v2');
  expect(deletion).toContain('--expected-bucket-owner');
  expect(aws.run.mock.calls.some(([, args]) => args[1] === 'abort-multipart-upload')).toBe(true);

  const finalized = {
    ...captured,
    inventory: { ...captured.inventory, retiredControls: manifest },
  };

  expect(() => parseSandboxRecord(finalized)).not.toThrow();

  await cloud.retire(finalized);

  expect(aws.run.mock.calls.filter(([, args]) => args[1] === 'close-account')).toHaveLength(1);
});

test('unknown legacy manifest, cross-account identities and unsupported retained types fail closed', async () => {
  const aws = fake();
  const cloud = new AwsCliSandboxCloud(aws.run);
  const base = record();

  aws.setDeleted();

  await expect(cloud.verifyRetirement(base)).rejects.toThrow(/manifest/);

  const snapshot = fake();
  const snapshotCloud = new AwsCliSandboxCloud(snapshot.run);
  const manifest = await snapshotCloud.captureControls(base, now);

  expect(() =>
    parseSandboxRecord({
      ...base,
      inventory: {
        ...base.inventory,
        retiredControls: {
          ...manifest,
          stackId: manifest.stackId.replace(accountId, '333333333333'),
        },
      },
    }),
  ).toThrow(/stackId/);

  snapshot.run.mockImplementation((_access, args) => {
    if (args[1] === 'describe-stacks') {
      return { Stacks: [{ StackId: stackId, StackStatus: 'CREATE_COMPLETE' }] };
    }

    if (args[1] === 'get-template') {
      return {
        TemplateBody: {
          Resources: {
            ...template.Resources,
            Unknown: { Type: 'AWS::KMS::Key', DeletionPolicy: 'Retain' },
          },
        },
      };
    }

    if (args[1] === 'list-stack-resources') {
      return { StackResourceSummaries: actual };
    }

    return {};
  });

  await expect(snapshotCloud.captureControls(base, now)).rejects.toThrow(/Unknown retained/);
});

test('changed post-capture template cannot hide unlisted retained resources', async () => {
  const aws = fake();
  const cloud = new AwsCliSandboxCloud(aws.run);
  const base = record();
  const manifest = await cloud.captureControls(base, now);

  aws.setDeleted();
  const delegate = aws.run.getMockImplementation()!;

  aws.run.mockImplementation((access, args) =>
    args[1] === 'get-template'
      ? {
          TemplateBody: {
            Resources: { ...template.Resources, NewTable: { Type: 'AWS::DynamoDB::Table' } },
          },
        }
      : delegate(access, args),
  );

  await expect(
    cloud.finalizeControls(
      { ...base, inventory: { ...base.inventory, retiredControls: manifest } },
      now,
    ),
  ).rejects.toThrow(/changed after capture/);

  expect(
    aws.run.mock.calls.some(
      ([, args]) => args[1] === 'delete-table' || args[1] === 'close-account',
    ),
  ).toBe(false);
});

test('bucket cleanup stops at ten version batches without deleting bucket or closing account', async () => {
  const aws = fake();
  const cloud = new AwsCliSandboxCloud(aws.run);
  const base = record();
  const manifest = await cloud.captureControls(base, now);

  aws.setDeleted();
  aws.setRemaining('bucket');
  const delegate = aws.run.getMockImplementation()!;

  aws.run.mockImplementation((access, args) =>
    args[1] === 'list-object-versions'
      ? { Versions: [{ Key: 'still-pending', VersionId: 'v1' }] }
      : delegate(access, args),
  );

  await expect(
    cloud.finalizeControls(
      { ...base, inventory: { ...base.inventory, retiredControls: manifest } },
      now,
    ),
  ).rejects.toThrow(/ten cleanup batches/);

  expect(aws.run.mock.calls.filter(([, args]) => args[1] === 'delete-objects')).toHaveLength(10);

  expect(
    aws.run.mock.calls.some(
      ([, args]) => args[1] === 'delete-bucket' || args[1] === 'close-account',
    ),
  ).toBe(false);
});

test('bucket AccessDenied is unknown, never accepted as absence', async () => {
  const aws = fake();
  const cloud = new AwsCliSandboxCloud(aws.run);
  const base = record();
  const manifest = await cloud.captureControls(base, now);

  aws.setDeleted();
  const delegate = aws.run.getMockImplementation()!;

  aws.run.mockImplementation((access, args) => {
    if (args[1] === 'head-bucket') {
      throw new AwsOperationError('403');
    }

    return delegate(access, args);
  });

  await expect(
    cloud.finalizeControls(
      { ...base, inventory: { ...base.inventory, retiredControls: manifest } },
      now,
    ),
  ).rejects.toThrow(/failed/);

  expect(
    aws.run.mock.calls.some(
      ([, args]) => args[1] === 'delete-bucket' || args[1] === 'close-account',
    ),
  ).toBe(false);
});

test('closure status requires actual pending/closed response, never retries close for ACTIVE', async () => {
  const aws = fake();
  const cloud = new AwsCliSandboxCloud(aws.run);
  const base = record();

  aws.run.mockReturnValue({ Account: { Id: accountId, State: 'ACTIVE' } });

  await expect(cloud.retirementStatus(base)).rejects.toThrow(/not confirmed/);

  aws.run.mockReturnValue({ Account: { Id: accountId, State: 'PENDING_CLOSURE' } });

  expect(await cloud.retirementStatus(base)).toBe('closure-requested');
  expect(aws.run.mock.calls.some(([, args]) => args[1] === 'close-account')).toBe(false);
});
