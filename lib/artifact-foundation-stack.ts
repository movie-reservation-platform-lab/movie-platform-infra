import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

const REPOSITORY_NAME = 'movie-reservation-service';
const UNTAGGED_IMAGE_MAX_AGE = cdk.Duration.days(7);

const REPOSITORY_TAGS = {
  Platform: 'movie-reservation-platform',
  Service: 'movie-reservation-service',
  Scope: 'artifact-foundation',
  Lifecycle: 'persistent',
  ManagedBy: 'aws-cdk',
} as const;

/**
 * Persistent, account-local resources used to admit application artifacts.
 *
 * This stack is deliberately independent from `GoldenPathDemoStack`: routine
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

    const repository = new ecr.Repository(this, 'MovieReservationServiceRepository', {
      repositoryName: REPOSITORY_NAME,
      encryption: ecr.RepositoryEncryption.AES_256,
      imageScanOnPush: false,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [
        {
          description: 'Expire untagged images after seven days',
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: UNTAGGED_IMAGE_MAX_AGE,
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

    for (const [key, value] of Object.entries(REPOSITORY_TAGS)) {
      cdk.Tags.of(repository).add(key, value);
    }

    new cdk.CfnOutput(this, 'MovieReservationServiceRepositoryName', {
      description: 'Name of the ECR repository that receives admitted reservation-service images',
      value: repository.repositoryName,
    });
    new cdk.CfnOutput(this, 'MovieReservationServiceRepositoryUri', {
      description: 'URI of the ECR repository that receives admitted reservation-service images',
      value: repository.repositoryUri,
    });
    new cdk.CfnOutput(this, 'MovieReservationServiceRepositoryArn', {
      description: 'ARN of the ECR repository that receives admitted reservation-service images',
      value: repository.repositoryArn,
    });
  }
}
