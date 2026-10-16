import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import type { Construct } from 'constructs';

/**
 * Spike-owned ECR repository for the fixture image variants.
 *
 * It is a separate stack so the operator can push every variant before the
 * service stack starts its first task. The service stack then receives only a
 * digest parameter, as the per-component construct (#103) will.
 */
export class EcsCanarySpikeImageRepositoryStack extends Stack {
  public readonly repository: ecr.Repository;

  public constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.repository = new ecr.Repository(this, 'FixtureImageRepository', {
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      emptyOnDelete: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
