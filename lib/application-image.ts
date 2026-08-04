import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

import { readDockerfileIgnorePatterns } from './assets/docker-build-context';
import { readPackageVersion } from './assets/package-metadata';
import type { ApplicationImageConfig } from './config/platform-config';

const APP_DOCKERFILE = 'movie-reservation-service/Dockerfile';

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
  if (applicationImageConfig.kind === 'ecr-image') {
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

  const repositoryRoot = path.join(__dirname, '..', '..');
  const appImage = new ecrAssets.DockerImageAsset(scope, 'AppImage', {
    directory: repositoryRoot,
    file: APP_DOCKERFILE,
    exclude: readDockerfileIgnorePatterns(repositoryRoot, APP_DOCKERFILE),
    ignoreMode: cdk.IgnoreMode.DOCKER,
  });
  const serviceVersion = readPackageVersion(path.join(repositoryRoot, 'movie-reservation-service', 'package.json'));

  return {
    image: ecs.ContainerImage.fromDockerImageAsset(appImage),
    serviceVersion,
  };
}
