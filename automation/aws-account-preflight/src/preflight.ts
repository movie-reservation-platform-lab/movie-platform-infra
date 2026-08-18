import { validateAwsCliIdentity } from './aws-cli';
import { loadAwsTarget } from './target-file';

/**
 * Execute the complete read-only target, profile, credential-source, and STS gate.
 *
 * @internal
 */
export function runPreflight(environment: NodeJS.ProcessEnv): string {
  const target = loadAwsTarget(environment);
  const permissionSet = validateAwsCliIdentity(target, environment);

  return [
    'AWS account preflight passed',
    `  profile: ${target.profile}`,
    `  region: ${target.region}`,
    `  permission set: ${permissionSet}`,
    `  account last four: ${target.accountId.slice(-4)}`,
    '',
  ].join('\n');
}
