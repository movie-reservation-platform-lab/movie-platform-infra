import * as cdk from 'aws-cdk-lib';

export const PLATFORM_NAME = 'movie-reservation-platform';
export const ENVIRONMENT_NAME = 'aws-demo';
export const EXPORT_PREFIX = 'MoviePlatformAwsDemo';
export const COMPONENTS = [
  'reservation-web', 'reservation-agent', 'reservation-mcp',
  'recommendation-mcp', 'reservation-service', 'recommendation-service',
] as const;

/** Explicit one-way foundation contract. Workload never grants back into foundations. */
export const importFoundationOutput = (name: string): string =>
  cdk.Fn.importValue(`${EXPORT_PREFIX}:${name}`);

export function foundationOutput(stack: cdk.Stack, name: string, value: string): void {
  new cdk.CfnOutput(stack, name, { value, exportName: `${EXPORT_PREFIX}:${name}` });
}
