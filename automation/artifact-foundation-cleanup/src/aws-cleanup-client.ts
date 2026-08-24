import {
  CloudFormationClient,
  DeleteStackCommand,
  UpdateTerminationProtectionCommand,
  waitUntilStackDeleteComplete,
} from '@aws-sdk/client-cloudformation';
import { DeleteRepositoryCommand, ECRClient } from '@aws-sdk/client-ecr';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

import {
  validateAwsCallerIdentity,
  type AwsTarget,
  type ValidatedAwsAccess,
} from '../../aws-account-preflight/src';
import { createPinnedAwsCredentials } from './aws-client-config';
import { failCleanup } from './cleanup-error';
import type {
  ArtifactFoundationCleaner,
  RepositoryCleanupTarget,
} from './model';

type CloudFormationMutationClient = Pick<CloudFormationClient, 'send'>;
type EcrMutationClient = Pick<ECRClient, 'send'>;
type StsReadClient = Pick<STSClient, 'send'>;
type StackDeletionWaiter = (stackName: string) => Promise<void>;

const STACK_DELETE_MAX_WAIT_SECONDS = 60 * 60;

/**
 * Build the destructive AWS adapter from the exact profile and Region approved
 * by preflight. The adapter is created only after all execution gates pass.
 */
export function createAwsSdkCleaner(
  access: ValidatedAwsAccess,
): ArtifactFoundationCleaner {
  const credentials = createPinnedAwsCredentials(access);
  const cloudFormation = new CloudFormationClient({
    region: access.target.region,
    credentials,
  });

  return new AwsSdkArtifactFoundationCleaner(
    access.target,
    cloudFormation,
    new ECRClient({ region: access.target.region, credentials }),
    new STSClient({ region: access.target.region, credentials }),
    async (stackName) => {
      await waitUntilStackDeleteComplete(
        {
          client: cloudFormation,
          maxWaitTime: STACK_DELETE_MAX_WAIT_SECONDS,
        },
        { StackName: stackName },
      );
    },
  );
}

/** AWS SDK v3 mutation adapter kept injectable for credential-free tests. */
export class AwsSdkArtifactFoundationCleaner
  implements ArtifactFoundationCleaner
{
  constructor(
    private readonly target: AwsTarget,
    private readonly cloudFormation: CloudFormationMutationClient,
    private readonly ecr: EcrMutationClient,
    private readonly sts: StsReadClient,
    private readonly waitForStackDelete: StackDeletionWaiter,
  ) {}

  /** Re-check the mutation client's caller before the first destructive call. */
  async verifyIdentity(): Promise<void> {
    let response;
    try {
      response = await this.sts.send(new GetCallerIdentityCommand({}));
    } catch {
      failCleanup('unable to verify the cleanup SDK caller identity');
    }

    if (response.Account === undefined || response.Arn === undefined) {
      failCleanup('STS returned an unexpected cleanup caller identity shape');
    }
    validateAwsCallerIdentity(this.target, response.Account, response.Arn);
  }

  /** Disable the stack-level guard immediately before requesting deletion. */
  async disableStackTerminationProtection(stackName: string): Promise<void> {
    try {
      await this.cloudFormation.send(
        new UpdateTerminationProtectionCommand({
          StackName: stackName,
          EnableTerminationProtection: false,
        }),
      );
    } catch {
      failCleanup(
        'unable to disable foundation termination protection; stack deletion was not requested',
      );
    }
  }

  /** Request normal CloudFormation deletion so retained resources stay retained. */
  async deleteStack(stackName: string): Promise<void> {
    try {
      await this.cloudFormation.send(new DeleteStackCommand({ StackName: stackName }));
    } catch {
      failCleanup('unable to request foundation stack deletion; ECR repositories were preserved');
    }
  }

  /** Wait for confirmed stack absence before any retained repository is deleted. */
  async waitForStackDeletion(stackName: string): Promise<void> {
    try {
      await this.waitForStackDelete(stackName);
    } catch {
      failCleanup(
        'foundation stack deletion did not complete; ECR repositories were preserved and cleanup can be retried',
      );
    }
  }

  /** Force-delete one exact retained repository and every image it contains. */
  async deleteRepository(repository: RepositoryCleanupTarget): Promise<void> {
    if (repository.registryId !== this.target.accountId) {
      failCleanup('refusing to delete an ECR repository outside the pinned account');
    }

    try {
      await this.ecr.send(
        new DeleteRepositoryCommand({
          registryId: repository.registryId,
          repositoryName: repository.name,
          force: true,
        }),
      );
    } catch (error: unknown) {
      if (hasErrorName(error, 'RepositoryNotFoundException')) {
        return;
      }
      failCleanup(
        `unable to delete retained ECR repository for ${repository.componentId}; cleanup can be retried`,
      );
    }
  }
}

function hasErrorName(error: unknown, expectedName: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === expectedName
  );
}
