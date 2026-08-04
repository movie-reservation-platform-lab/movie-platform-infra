import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

import type { ApplicationImageConfig } from './config/platform-config';

/** Application image and release metadata consumed by the ECS task definition. */
export interface ResolvedApplicationImage {
  readonly image: ecs.ContainerImage;
  readonly serviceVersion: string;
}

/** Resolves a validated application image contract into an ECS container image. */
export function resolveApplicationImage(
  scope: Construct,
  applicationImageConfig: ApplicationImageConfig,
): ResolvedApplicationImage {
  const repository = ecr.Repository.fromRepositoryName(
    scope,
    'ApplicationImageRepository',
    applicationImageConfig.repositoryName,
  );

  return {
    image: ecs.ContainerImage.fromEcrRepository(repository, applicationImageConfig.imageDigest),
    serviceVersion: applicationImageConfig.serviceVersion,
  };
}
