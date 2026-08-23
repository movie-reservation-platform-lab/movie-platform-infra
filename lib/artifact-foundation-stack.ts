import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

import {
  ARTIFACT_FOUNDATION_REPOSITORIES,
  type ArtifactFoundationRepositoryDefinition,
} from './artifact-foundation-repositories';

/**
 * Persistent, account-local resources used to admit application artifacts.
 *
 * This stack is deliberately independent from `MovieReservationWorkloadStack`: routine
 * demo teardown can remove the workload without deleting admitted images.
 * Termination protection guards the stack, while the repository's retain
 * policy also protects it if stack deletion is explicitly requested.
 */
export class ArtifactFoundationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps = {}) {
    super(scope, id, {
      ...props,
      terminationProtection: true,
    });

    for (const definition of ARTIFACT_FOUNDATION_REPOSITORIES) {
      createArtifactRepository(this, definition);
    }
  }
}

/**
 * Create an ECR artifact repository for the selected definition
 *
 * @param scope
 * @param definition
 */
function createArtifactRepository(
  scope: Construct,
  definition: ArtifactFoundationRepositoryDefinition,
): void {
  const repository = new ecr.Repository(scope, definition.constructId, {
    repositoryName: definition.repositoryName,
    encryption: ecr.RepositoryEncryption.AES_256,
    imageScanOnPush: false,
    imageTagMutability: ecr.TagMutability.IMMUTABLE,
    lifecycleRules: [
      {
        description: 'Expire untagged images after seven days',
        tagStatus: ecr.TagStatus.UNTAGGED,
        maxImageAge: cdk.Duration.days(7),
      },
    ],
    emptyOnDelete: false,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  // The ECR L2 construct omits AES-256 from CloudFormation because it is the
  // AWS default, even when `encryption` is explicitly supplied above. Keep
  // the L2's ergonomic repository API while making the approved encryption
  // contract explicit in the synthesized template.
  const cfnRepository = repository.node.defaultChild;
  if (!(cfnRepository instanceof ecr.CfnRepository)) {
    throw new Error(
      'Expected the ECR repository L2 construct to contain an AWS::ECR::Repository resource.',
    );
  }
  cfnRepository.encryptionConfiguration = {
    encryptionType: 'AES256',
  };

  for (const [key, value] of Object.entries(definition.expectedTags)) {
    cdk.Tags.of(repository).add(key, value);
  }

  new cdk.CfnOutput(scope, definition.outputNames.name, {
    description: `Name of the ECR repository that receives admitted ${definition.displayName} artifacts`,
    value: repository.repositoryName,
  });
  new cdk.CfnOutput(scope, definition.outputNames.uri, {
    description: `URI of the ECR repository that receives admitted ${definition.displayName} artifacts`,
    value: repository.repositoryUri,
  });
  new cdk.CfnOutput(scope, definition.outputNames.arn, {
    description: `ARN of the ECR repository that receives admitted ${definition.displayName} artifacts`,
    value: repository.repositoryArn,
  });
}
