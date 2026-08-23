import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  DescribeRepositoriesCommand,
  ECRClient,
  GetLifecyclePolicyCommand,
  ListImagesCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-ecr';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

import { AwsSdkArtifactFoundationReader } from '../src/aws-read-client';
import { InspectionFailure } from '../src/inspection-error';
import {
  EXPECTED_LIFECYCLE_POLICY,
  RESERVATION_SERVICE_REPOSITORY_DEFINITION,
  TEST_DIGEST_A,
  TEST_DIGEST_B,
  TEST_TARGET,
} from './test-support';

type CloudFormationReadClient = Pick<CloudFormationClient, 'send'>;
type EcrReadClient = Pick<ECRClient, 'send'>;
type StsReadClient = Pick<STSClient, 'send'>;

const TEST_REPOSITORY_ARN =
  'arn:aws:ecr:eu-central-1:111111111111:repository/movie-reservation-service';
const TEST_REPOSITORY_URI =
  '111111111111.dkr.ecr.eu-central-1.amazonaws.com/movie-reservation-service';

function repositoryDescription() {
  return {
    registryId: TEST_TARGET.accountId,
    repositoryName: 'movie-reservation-service',
    repositoryArn: TEST_REPOSITORY_ARN,
    repositoryUri: TEST_REPOSITORY_URI,
    imageTagMutability: 'IMMUTABLE',
    imageTagMutabilityExclusionFilters: [],
    imageScanningConfiguration: { scanOnPush: false },
    encryptionConfiguration: { encryptionType: 'AES256' },
  };
}

function cloudFormationClient(
  handler: (command: unknown) => Promise<unknown>,
): CloudFormationReadClient {
  return { send: handler } as unknown as CloudFormationReadClient;
}

function ecrClient(handler: (command: unknown) => Promise<unknown>): EcrReadClient {
  return { send: handler } as unknown as EcrReadClient;
}

function stsClient(
  handler: (command: unknown) => Promise<unknown> = async () => ({
    Account: TEST_TARGET.accountId,
    Arn:
      `arn:aws:sts::${TEST_TARGET.accountId}:assumed-role/` +
      `${TEST_TARGET.expectedRoleName}/operator@example.invalid`,
  }),
): StsReadClient {
  return { send: handler } as unknown as StsReadClient;
}

function inspectRepository(
  reader: AwsSdkArtifactFoundationReader,
): Promise<unknown> {
  return reader.inspectRepository(RESERVATION_SERVICE_REPOSITORY_DEFINITION);
}

test('verifies the exact SDK caller with one read-only STS command', async () => {
  const commands: unknown[] = [];
  const reader = new AwsSdkArtifactFoundationReader(
    TEST_TARGET,
    cloudFormationClient(async () => ({})),
    ecrClient(async () => ({})),
    stsClient(async (command) => {
      commands.push(command);
      return {
        Account: TEST_TARGET.accountId,
        Arn:
          `arn:aws:sts::${TEST_TARGET.accountId}:assumed-role/` +
          `${TEST_TARGET.expectedRoleName}/operator@example.invalid`,
      };
    }),
  );

  await expect(reader.verifyIdentity()).resolves.toBeUndefined();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toBeInstanceOf(GetCallerIdentityCommand);
  expect((commands[0] as GetCallerIdentityCommand).input).toEqual({});
});

test('rejects an SDK caller outside the preflight-approved target', async () => {
  const reader = new AwsSdkArtifactFoundationReader(
    TEST_TARGET,
    cloudFormationClient(async () => ({})),
    ecrClient(async () => ({})),
    stsClient(async () => ({
      Account: '222222222222',
      Arn:
        'arn:aws:sts::222222222222:assumed-role/' +
        `${TEST_TARGET.expectedRoleName}/operator@example.invalid`,
    })),
  );

  await expect(reader.verifyIdentity()).rejects.toThrow(
    'the live caller account does not match the pinned target',
  );
});

test('sanitizes unexpected SDK identity failures', async () => {
  const reader = new AwsSdkArtifactFoundationReader(
    TEST_TARGET,
    cloudFormationClient(async () => ({})),
    ecrClient(async () => ({})),
    stsClient(async () => {
      throw new Error('private STS diagnostic for 111111111111');
    }),
  );

  await expect(reader.verifyIdentity()).rejects.toThrow('unable to verify the SDK caller identity');
  await expect(reader.verifyIdentity()).rejects.not.toThrow('private STS diagnostic');
});

test('inspects an exact CloudFormation stack with one read command', async () => {
  const commands: unknown[] = [];
  const reader = new AwsSdkArtifactFoundationReader(
    TEST_TARGET,
    cloudFormationClient(async (command) => {
      commands.push(command);
      return {
        Stacks: [
          {
            StackName: 'ArtifactFoundationStack',
            StackId:
              'arn:aws:cloudformation:eu-central-1:111111111111:stack/ArtifactFoundationStack/test-id',
            StackStatus: 'CREATE_COMPLETE',
            EnableTerminationProtection: true,
            Outputs: [{ OutputKey: 'RepositoryName', OutputValue: 'movie-reservation-service' }],
          },
        ],
      };
    }),
    ecrClient(async () => {
      throw new Error('ECR must not be called');
    }),
    stsClient(),
  );

  await expect(reader.inspectStack('ArtifactFoundationStack')).resolves.toEqual({
    name: 'ArtifactFoundationStack',
    status: 'CREATE_COMPLETE',
    terminationProtection: true,
    outputs: { RepositoryName: 'movie-reservation-service' },
  });
  expect(commands).toHaveLength(1);
  expect(commands[0]).toBeInstanceOf(DescribeStacksCommand);
  expect((commands[0] as DescribeStacksCommand).input).toEqual({
    StackName: 'ArtifactFoundationStack',
  });
});

test('maps the precise CloudFormation missing-stack response to absence', async () => {
  const reader = new AwsSdkArtifactFoundationReader(
    TEST_TARGET,
    cloudFormationClient(async () => {
      const error = new Error('Stack with id ArtifactFoundationStack does not exist');
      error.name = 'ValidationError';
      throw error;
    }),
    ecrClient(async () => ({})),
    stsClient(),
  );

  await expect(reader.inspectStack('ArtifactFoundationStack')).resolves.toBeUndefined();
});

test('sanitizes unexpected CloudFormation failures', async () => {
  const reader = new AwsSdkArtifactFoundationReader(
    TEST_TARGET,
    cloudFormationClient(async () => {
      throw new Error('private SDK diagnostic with account 111111111111');
    }),
    ecrClient(async () => ({})),
    stsClient(),
  );

  await expect(reader.inspectStack('ArtifactFoundationStack')).rejects.toThrow(
    'unable to inspect the CloudFormation stack',
  );
  await expect(reader.inspectStack('ArtifactFoundationStack')).rejects.not.toThrow(
    'private SDK diagnostic',
  );
});

test('refuses a CloudFormation stack ARN outside the pinned account and Region', async () => {
  const reader = new AwsSdkArtifactFoundationReader(
    TEST_TARGET,
    cloudFormationClient(async () => ({
      Stacks: [
        {
          StackName: 'ArtifactFoundationStack',
          StackId:
            'arn:aws:cloudformation:us-east-1:222222222222:stack/ArtifactFoundationStack/test-id',
          StackStatus: 'CREATE_COMPLETE',
        },
      ],
    })),
    ecrClient(async () => ({})),
    stsClient(),
  );

  await expect(reader.inspectStack('ArtifactFoundationStack')).rejects.toThrow(
    'CloudFormation returned a stack outside the requested target',
  );
});

test('inventories repository settings, tags, lifecycle, and paginated image digests using read commands only', async () => {
  const commands: unknown[] = [];
  const reader = new AwsSdkArtifactFoundationReader(
    TEST_TARGET,
    cloudFormationClient(async () => {
      throw new Error('CloudFormation must not be called');
    }),
    ecrClient(async (command) => {
      commands.push(command);
      if (command instanceof DescribeRepositoriesCommand) {
        return { repositories: [repositoryDescription()] };
      }
      if (command instanceof ListTagsForResourceCommand) {
        return { tags: [{ Key: 'Scope', Value: 'artifact-foundation' }] };
      }
      if (command instanceof GetLifecyclePolicyCommand) {
        return { lifecyclePolicyText: EXPECTED_LIFECYCLE_POLICY };
      }
      if (command instanceof ListImagesCommand && command.input.nextToken === undefined) {
        return {
          imageIds: [
            { imageDigest: TEST_DIGEST_A, imageTag: 'release-2' },
            { imageDigest: TEST_DIGEST_A, imageTag: 'release-1' },
          ],
          nextToken: 'second-page',
        };
      }
      if (command instanceof ListImagesCommand && command.input.nextToken === 'second-page') {
        return {
          imageIds: [{ imageDigest: TEST_DIGEST_B }],
        };
      }
      throw new Error(`Unexpected command ${String(command)}`);
    }),
    stsClient(),
  );

  await expect(inspectRepository(reader)).resolves.toEqual({
    componentId: RESERVATION_SERVICE_REPOSITORY_DEFINITION.componentId,
    displayName: RESERVATION_SERVICE_REPOSITORY_DEFINITION.displayName,
    artifactKind: RESERVATION_SERVICE_REPOSITORY_DEFINITION.artifactKind,
    registryId: TEST_TARGET.accountId,
    name: RESERVATION_SERVICE_REPOSITORY_DEFINITION.repositoryName,
    arn: TEST_REPOSITORY_ARN,
    uri: TEST_REPOSITORY_URI,
    tagMutability: 'IMMUTABLE',
    tagMutabilityExclusions: [],
    scanOnPush: false,
    encryptionType: 'AES256',
    encryptionKey: undefined,
    tags: { Scope: 'artifact-foundation' },
    lifecyclePolicyText: EXPECTED_LIFECYCLE_POLICY,
    images: [
      { digest: TEST_DIGEST_A, tags: ['release-1', 'release-2'] },
      { digest: TEST_DIGEST_B, tags: [] },
    ],
  });

  expect(
    commands.map(
      (command) =>
        (command as { readonly constructor: { readonly name: string } }).constructor.name,
    ),
  ).toEqual([
    'DescribeRepositoriesCommand',
    'ListTagsForResourceCommand',
    'GetLifecyclePolicyCommand',
    'ListImagesCommand',
    'ListImagesCommand',
  ]);
  for (const command of commands) {
    if (
      command instanceof DescribeRepositoriesCommand ||
      command instanceof GetLifecyclePolicyCommand ||
      command instanceof ListImagesCommand
    ) {
      expect(command.input.registryId).toBe(TEST_TARGET.accountId);
    }
    if (
      command instanceof GetLifecyclePolicyCommand ||
      command instanceof ListImagesCommand
    ) {
      expect(command.input.repositoryName).toBe(
        RESERVATION_SERVICE_REPOSITORY_DEFINITION.repositoryName,
      );
    }
    if (command instanceof DescribeRepositoriesCommand) {
      expect(command.input.repositoryNames).toEqual([
        RESERVATION_SERVICE_REPOSITORY_DEFINITION.repositoryName,
      ]);
    }
    if (command instanceof ListImagesCommand) {
      expect(command.input.filter).toEqual({ imageStatus: 'ANY' });
    }
  }
});

test('reports an absent repository without issuing follow-up ECR commands', async () => {
  const commands: unknown[] = [];
  const reader = new AwsSdkArtifactFoundationReader(
    TEST_TARGET,
    cloudFormationClient(async () => ({})),
    ecrClient(async (command) => {
      commands.push(command);
      const error = new Error('private repository detail');
      error.name = 'RepositoryNotFoundException';
      throw error;
    }),
    stsClient(),
  );

  await expect(inspectRepository(reader)).resolves.toBeUndefined();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toBeInstanceOf(DescribeRepositoriesCommand);
});

test('refuses a repository identity outside the pinned target', async () => {
  const reader = new AwsSdkArtifactFoundationReader(
    TEST_TARGET,
    cloudFormationClient(async () => ({})),
    ecrClient(async (command) => {
      if (command instanceof DescribeRepositoriesCommand) {
        return {
          repositories: [
            {
              registryId: '222222222222',
              repositoryName: 'movie-reservation-service',
              repositoryArn:
                'arn:aws:ecr:eu-central-1:222222222222:repository/movie-reservation-service',
              repositoryUri:
                '222222222222.dkr.ecr.eu-central-1.amazonaws.com/movie-reservation-service',
            },
          ],
        };
      }
      throw new Error('follow-up commands must not run');
    }),
    stsClient(),
  );

  await expect(inspectRepository(reader)).rejects.toBeInstanceOf(InspectionFailure);
  await expect(inspectRepository(reader)).rejects.toThrow(
    'ECR returned a repository outside the pinned target',
  );
});

test('rejects malformed repository tags instead of creating an ambiguous tag map', async () => {
  const reader = new AwsSdkArtifactFoundationReader(
    TEST_TARGET,
    cloudFormationClient(async () => ({})),
    ecrClient(async (command) => {
      if (command instanceof DescribeRepositoriesCommand) {
        return { repositories: [repositoryDescription()] };
      }
      if (command instanceof ListTagsForResourceCommand) {
        return { tags: [{ Key: 'Scope' }] };
      }
      if (command instanceof GetLifecyclePolicyCommand) {
        return { lifecyclePolicyText: EXPECTED_LIFECYCLE_POLICY };
      }
      if (command instanceof ListImagesCommand) {
        return { imageIds: [] };
      }
      throw new Error('unexpected command');
    }),
    stsClient(),
  );

  await expect(inspectRepository(reader)).rejects.toThrow(
    'ECR returned an unexpected repository tag',
  );
});

test('sanitizes unexpected lifecycle-policy failures', async () => {
  const reader = new AwsSdkArtifactFoundationReader(
    TEST_TARGET,
    cloudFormationClient(async () => ({})),
    ecrClient(async (command) => {
      if (command instanceof DescribeRepositoriesCommand) {
        return { repositories: [repositoryDescription()] };
      }
      if (command instanceof ListTagsForResourceCommand) {
        return { tags: [] };
      }
      if (command instanceof GetLifecyclePolicyCommand) {
        throw new Error('private lifecycle diagnostic for 111111111111');
      }
      if (command instanceof ListImagesCommand) {
        return { imageIds: [] };
      }
      throw new Error('unexpected command');
    }),
    stsClient(),
  );

  await expect(inspectRepository(reader)).rejects.toThrow(
    'unable to inspect the ECR lifecycle policy',
  );
  await expect(inspectRepository(reader)).rejects.not.toThrow('private lifecycle diagnostic');
});

test('rejects a repeated ECR image pagination token', async () => {
  let imagePageCalls = 0;
  const reader = new AwsSdkArtifactFoundationReader(
    TEST_TARGET,
    cloudFormationClient(async () => ({})),
    ecrClient(async (command) => {
      if (command instanceof DescribeRepositoriesCommand) {
        return { repositories: [repositoryDescription()] };
      }
      if (command instanceof ListTagsForResourceCommand) {
        return { tags: [] };
      }
      if (command instanceof GetLifecyclePolicyCommand) {
        return { lifecyclePolicyText: EXPECTED_LIFECYCLE_POLICY };
      }
      if (command instanceof ListImagesCommand) {
        imagePageCalls += 1;
        return { imageIds: [], nextToken: 'repeated-token' };
      }
      throw new Error('unexpected command');
    }),
    stsClient(),
  );

  await expect(inspectRepository(reader)).rejects.toThrow(
    'ECR returned a repeated image pagination token',
  );
  expect(imagePageCalls).toBe(2);
});

test.each([undefined, 'sha256:not-a-digest'])(
  'rejects an invalid ECR image digest (%s)',
  async (imageDigest) => {
    const reader = new AwsSdkArtifactFoundationReader(
      TEST_TARGET,
      cloudFormationClient(async () => ({})),
      ecrClient(async (command) => {
        if (command instanceof DescribeRepositoriesCommand) {
          return { repositories: [repositoryDescription()] };
        }
        if (command instanceof ListTagsForResourceCommand) {
          return { tags: [] };
        }
        if (command instanceof GetLifecyclePolicyCommand) {
          return { lifecyclePolicyText: EXPECTED_LIFECYCLE_POLICY };
        }
        if (command instanceof ListImagesCommand) {
          return { imageIds: [{ imageDigest }] };
        }
        throw new Error('unexpected command');
      }),
      stsClient(),
    );

    await expect(inspectRepository(reader)).rejects.toThrow(
      'ECR returned an unexpected image digest',
    );
  },
);
