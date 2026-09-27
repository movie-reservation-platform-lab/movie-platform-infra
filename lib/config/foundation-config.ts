export interface ObservabilityConfig {
  readonly platformName: 'movie-reservation-platform';
  readonly environmentName: 'aws-demo';
  readonly serviceName: 'movie-platform-demo';
  readonly allowedIngressPrefixListId: string;
  readonly enableGrafana: boolean;
}

export function contextBoolean(value: unknown, key: string): boolean {
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new Error(`CDK context "${key}" must be true or false.`);
}

export function resolveObservabilityConfig(context: {
  allowedIngressPrefixListId?: unknown;
  enableGrafana?: unknown;
}): ObservabilityConfig {
  const prefixList = context.allowedIngressPrefixListId;
  if (typeof prefixList !== 'string' || !/^pl-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(prefixList)) {
    throw new Error('allowedIngressPrefixListId must be a concrete EC2 prefix list ID.');
  }
  return {
    platformName: 'movie-reservation-platform',
    environmentName: 'aws-demo',
    serviceName: 'movie-platform-demo',
    allowedIngressPrefixListId: prefixList,
    enableGrafana: context.enableGrafana === undefined ? true :
      contextBoolean(context.enableGrafana, 'enableGrafana'),
  };
}
