import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

import { readDockerfileIgnorePatterns } from './assets/docker-build-context';
import { readPackageVersion } from './assets/package-metadata';

const APP_DOCKERFILE = 'movie-reservation-service/Dockerfile';

/** Application image and release metadata consumed by the ECS task definition. */
export interface ResolvedApplicationImage {
  readonly image: ecs.ContainerImage;
  readonly serviceVersion: string;
}

/** Resolves the repository-owned application source into the existing CDK image asset. */
export function resolveApplicationImage(scope: Construct): ResolvedApplicationImage {
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
