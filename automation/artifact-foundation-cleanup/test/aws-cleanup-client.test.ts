import {
  CloudFormationClient,
  DeleteStackCommand,
  UpdateTerminationProtectionCommand,
} from '@aws-sdk/client-cloudformation';
import { DeleteRepositoryCommand, ECRClient } from '@aws-sdk/client-ecr';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

import { AwsSdkArtifactFoundationCleaner } from '../src/aws-cleanup-client';
import { CleanupFailure } from '../src/cleanup-error';
import type { RepositoryCleanupTarget } from '../src/model';
import { TEST_TARGET } from './test-support';

type CloudFormationMutationClient = Pick<CloudFormationClient, 'send'>;
type EcrMutationClient = Pick<ECRClient, 'send'>;
type StsReadClient = Pick<STSClient, 'send'>;

const REPOSITORY_TARGET = Object.freeze({
  componentId: 'reservation-service',
  registryId: TEST_TARGET.accountId,
  name: 'movie-reservation-service',
} satisfies RepositoryCleanupTarget);

function cloudFormationClient(
  handler: (command: unknown) => Promise<unknown>,
): CloudFormationMutationClient {
  return { send: handler } as unknown as CloudFormationMutationClient;
}

function ecrClient(handler: (command: unknown) => Promise<unknown>): EcrMutationClient {
  return { send: handler } as unknown as EcrMutationClient;
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

test('sends only the exact approved AWS SDK v3 mutation commands', async () => {
  const cloudFormationCommands: unknown[] = [];
  const ecrCommands: unknown[] = [];
  const stsCommands: unknown[] = [];
  const waiterStacks: string[] = [];
  const cleaner = new AwsSdkArtifactFoundationCleaner(
    TEST_TARGET,
    cloudFormationClient(async (command) => {
      cloudFormationCommands.push(command);
      return {};
    }),
    ecrClient(async (command) => {
      ecrCommands.push(command);
      return {};
    }),
    stsClient(async (command) => {
      stsCommands.push(command);
      return {
        Account: TEST_TARGET.accountId,
        Arn:
          `arn:aws:sts::${TEST_TARGET.accountId}:assumed-role/` +
          `${TEST_TARGET.expectedRoleName}/operator@example.invalid`,
      };
    }),
    async (stackName) => {
      waiterStacks.push(stackName);
    },
  );

  await cleaner.verifyIdentity();
  await cleaner.disableStackTerminationProtection('ArtifactFoundationStack');
  await cleaner.deleteStack('ArtifactFoundationStack');
  await cleaner.waitForStackDeletion('ArtifactFoundationStack');
  await cleaner.deleteRepository(REPOSITORY_TARGET);

  expect(stsCommands).toHaveLength(1);
  expect(stsCommands[0]).toBeInstanceOf(GetCallerIdentityCommand);
  expect(cloudFormationCommands).toHaveLength(2);
  expect(cloudFormationCommands[0]).toBeInstanceOf(UpdateTerminationProtectionCommand);
  expect((cloudFormationCommands[0] as UpdateTerminationProtectionCommand).input).toEqual({
    StackName: 'ArtifactFoundationStack',
    EnableTerminationProtection: false,
  });
  expect(cloudFormationCommands[1]).toBeInstanceOf(DeleteStackCommand);
  expect((cloudFormationCommands[1] as DeleteStackCommand).input).toEqual({
    StackName: 'ArtifactFoundationStack',
  });
  expect(waiterStacks).toEqual(['ArtifactFoundationStack']);
  expect(ecrCommands).toHaveLength(1);
  expect(ecrCommands[0]).toBeInstanceOf(DeleteRepositoryCommand);
  expect((ecrCommands[0] as DeleteRepositoryCommand).input).toEqual({
    registryId: TEST_TARGET.accountId,
    repositoryName: 'movie-reservation-service',
    force: true,
  });
});

test('rejects a cleanup SDK caller outside the preflight-approved target', async () => {
  const cleaner = new AwsSdkArtifactFoundationCleaner(
    TEST_TARGET,
    cloudFormationClient(async () => ({})),
    ecrClient(async () => ({})),
    stsClient(async () => ({
      Account: '222222222222',
      Arn:
        'arn:aws:sts::222222222222:assumed-role/' +
        `${TEST_TARGET.expectedRoleName}/operator@example.invalid`,
    })),
    async () => undefined,
  );

  await expect(cleaner.verifyIdentity()).rejects.toThrow(
    'the live caller account does not match the pinned target',
  );
});

test('sanitizes waiter failure and leaves repository deletion to a later retry', async () => {
  const ecrSend = jest.fn(async () => ({}));
  const cleaner = new AwsSdkArtifactFoundationCleaner(
    TEST_TARGET,
    cloudFormationClient(async () => ({})),
    ecrClient(ecrSend),
    stsClient(),
    async () => {
      throw new Error('private waiter failure for 111111111111');
    },
  );

  await expect(cleaner.waitForStackDeletion('ArtifactFoundationStack')).rejects.toThrow(
    'foundation stack deletion did not complete',
  );
  await expect(cleaner.waitForStackDeletion('ArtifactFoundationStack')).rejects.not.toThrow(
    '111111111111',
  );
  expect(ecrSend).not.toHaveBeenCalled();
});

test('treats an already-absent repository as successful idempotent cleanup', async () => {
  const cleaner = new AwsSdkArtifactFoundationCleaner(
    TEST_TARGET,
    cloudFormationClient(async () => ({})),
    ecrClient(async () => {
      const error = new Error('repository is already absent');
      error.name = 'RepositoryNotFoundException';
      throw error;
    }),
    stsClient(),
    async () => undefined,
  );

  await expect(cleaner.deleteRepository(REPOSITORY_TARGET)).resolves.toBeUndefined();
});

test('refuses a repository from another registry before sending ECR commands', async () => {
  const ecrSend = jest.fn(async () => ({}));
  const cleaner = new AwsSdkArtifactFoundationCleaner(
    TEST_TARGET,
    cloudFormationClient(async () => ({})),
    ecrClient(ecrSend),
    stsClient(),
    async () => undefined,
  );

  await expect(
    cleaner.deleteRepository({ ...REPOSITORY_TARGET, registryId: '222222222222' }),
  ).rejects.toBeInstanceOf(CleanupFailure);
  expect(ecrSend).not.toHaveBeenCalled();
});
