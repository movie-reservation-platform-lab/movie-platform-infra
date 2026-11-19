import { isDigestImageReference } from '@movie-platform/experiment-sandbox';
import { exactKeys, object, string } from './json';

export interface RuntimeConfig {
  experimentId: string;
  region: string;
  cluster: string;
  service: string;
  recipeTaskDefinitionArn: string;
  containerName: string;
  goodImage: string;
  badImage: string;
  stateTableName: string;
  probeAlarmName: string;
}

const keys = [
  'experimentId',
  'region',
  'cluster',
  'service',
  'recipeTaskDefinitionArn',
  'containerName',
  'goodImage',
  'badImage',
  'stateTableName',
  'probeAlarmName',
] as const;

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  const input = object(value);

  exactKeys(input, keys);

  const config = Object.fromEntries(
    keys.map((key) => [key, string(input[key], key)]),
  ) as unknown as RuntimeConfig;

  if (
    config.region !== 'eu-central-1' ||
    !/^[-a-zA-Z0-9_]{1,80}$/.test(config.experimentId) ||
    !isDigestImageReference(config.goodImage) ||
    !isDigestImageReference(config.badImage) ||
    config.goodImage === config.badImage
  ) {
    throw new Error('unsafe runtime configuration');
  }

  if (config.goodImage.split('@')[0] !== config.badImage.split('@')[0]) {
    throw new Error('candidate repositories differ');
  }

  return config;
}
