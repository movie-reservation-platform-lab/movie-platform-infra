/**
 * Turns the operator record plus a small inputs file into the CDK app's config file, the
 * only input `apps/experiment-sandbox` accepts. Offline: no AWS call.
 */

import {
  parseSandboxConfig,
  parseSandboxRenderInputs,
  type SandboxConfig,
  type SandboxRecord,
} from '@movie-platform/experiment-sandbox';

/**
 * Builds the CDK app's config file from the operator record plus a small inputs file.
 *
 * The record supplies the account, experiment, region, images and lease; the inputs file
 * supplies only ingress, the tools and delegate images, the token secret and the Harness
 * account. The result is checked with the same schema the CDK app uses before synth.
 *
 * @param record - crucial sandbox metadata
 * @param inputs - parsed JSON from the operator's private inputs file
 * @throws Error when the account is not ready, the inputs contain unknown or invalid
 *   fields, or the combined config breaks a config rule
 */
export function renderSandboxConfig(record: SandboxRecord, inputs: unknown): SandboxConfig {
  if (record.account.state !== 'ready' || !record.account.accountId) {
    throw new Error('Render config requires ready dedicated account');
  }

  const operatorInputs = parseSandboxRenderInputs(inputs);

  return parseSandboxConfig({
    experimentId: record.id,
    accountId: record.account.accountId,
    region: record.region,
    expiresAt: record.lease.expiresAt,
    launchCutoffAt: record.lease.rejectNewWorkAt,
    goodImage: record.images.good,
    badImage: record.images.bad,
    ...operatorInputs,
  });
}
