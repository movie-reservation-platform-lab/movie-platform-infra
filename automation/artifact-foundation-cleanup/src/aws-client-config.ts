import { fromIni } from '@aws-sdk/credential-providers';

import type { ValidatedAwsAccess } from '../../aws-account-preflight/src';

/**
 * Build the explicit AWS SDK credential provider shared by read and mutation
 * adapters. Ambient credentials are deliberately excluded from cleanup.
 */
export function createPinnedAwsCredentials(
  access: ValidatedAwsAccess,
): ReturnType<typeof fromIni> {
  return fromIni({
    profile: access.target.profile,
    filepath: access.configFiles.credentialsFilepath,
    configFilepath: access.configFiles.configFilepath,
    clientConfig: { region: access.target.region },
    ignoreCache: true,
  });
}
