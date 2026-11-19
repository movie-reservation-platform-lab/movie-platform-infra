import { string } from './json';

export interface DelegateContext {
  experimentId: string;
  region: 'eu-central-1';
  launcherArn: string;
}

/** The installed delegate needs only fixed launch coordinates, never the operator journal. */
export function parseDelegateContext(environment: NodeJS.ProcessEnv): DelegateContext {
  if (
    !environment.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI &&
    !environment.AWS_CONTAINER_CREDENTIALS_FULL_URI
  ) {
    throw new Error('delegate requires isolated container credentials');
  }

  const experimentId = string(environment.EXPERIMENT_ID, 'EXPERIMENT_ID');
  const accountId = string(environment.SANDBOX_ACCOUNT_ID, 'SANDBOX_ACCOUNT_ID');
  const region = environment.SANDBOX_REGION;
  const launcherArn = string(environment.LAUNCHER_ARN, 'LAUNCHER_ARN');

  if (
    !/^exp-[a-z0-9-]{3,24}$/.test(experimentId) ||
    !/^\d{12}$/.test(accountId) ||
    region !== 'eu-central-1'
  ) {
    throw new Error('delegate requires its installed sandbox experiment, account and region');
  }

  if (
    !new RegExp(`^arn:aws:lambda:${region}:${accountId}:function:[A-Za-z0-9_-]+$`).test(launcherArn)
  ) {
    throw new Error('delegate launcher must belong to its installed sandbox account and region');
  }

  return { experimentId, region, launcherArn };
}
