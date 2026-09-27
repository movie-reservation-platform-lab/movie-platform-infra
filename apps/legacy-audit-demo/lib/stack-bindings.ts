import * as cdk from 'aws-cdk-lib';

export const PLATFORM_NAME = 'movie-reservation-platform';
export const ENVIRONMENT_NAME = 'aws-demo';
const EXPORT_PREFIX = 'MoviePlatformAwsDemo';

/** Preserve the output names consumed by the existing workload app. */
export function foundationOutput(stack: cdk.Stack, name: string, value: string): void {
  new cdk.CfnOutput(stack, name, { value, exportName: `${EXPORT_PREFIX}:${name}` });
}
