import { ReleaseObservation } from './release';
import { string } from './json';

const active = [
  'PENDING',
  'IN_PROGRESS',
  'STOP_REQUESTED',
  'ROLLBACK_REQUESTED',
  'ROLLBACK_IN_PROGRESS',
];

export function nativeDeploymentState(
  deployments: readonly Record<string, unknown>[],
  revision: string,
  originalRevision?: string,
): ReleaseObservation['state'] {
  if (!deployments.length) {
    throw new Error('native deployment observation missing');
  }

  for (const deployment of deployments) {
    if (
      ![...active, 'SUCCESSFUL', 'ROLLBACK_SUCCESSFUL', 'ROLLBACK_FAILED', 'STOPPED'].includes(
        string(deployment.status),
      ) ||
      !Number.isFinite(Date.parse(string(deployment.createdAt)))
    ) {
      throw new Error('unknown native deployment observation');
    }
  }

  if (deployments.some((deployment) => active.includes(string(deployment.status)))) {
    return 'ACTIVE';
  }

  const latest = [...deployments].sort(
    (a, b) => Date.parse(string(b.createdAt)) - Date.parse(string(a.createdAt)),
  )[0];

  if (latest.status === 'ROLLBACK_SUCCESSFUL') {
    return originalRevision ? (revision === originalRevision ? 'REVERTED' : 'FAILED') : 'COMPLETED';
  }

  if (latest.status === 'SUCCESSFUL') {
    return originalRevision && revision === originalRevision ? 'ACTIVE' : 'COMPLETED';
  }

  return 'FAILED';
}
