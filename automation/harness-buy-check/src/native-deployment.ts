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
    if (!originalRevision) {
      return 'COMPLETED';
    }

    return revision === originalRevision ? 'REVERTED' : 'PENDING';
  }

  if (latest.status === 'SUCCESSFUL') {
    return originalRevision && revision === originalRevision ? 'PENDING' : 'COMPLETED';
  }

  return 'FAILED';
}

/**
 * Binds one watcher or release task to the single ECS rollout following its baseline.
 * ListServiceDeployments and DescribeServices may expose a service update at different times.
 */
export class DeploymentHistory {
  private baseline?: Set<string>;
  private rollout?: string;

  /** Waits for the new deployment ARN and rejects competing or replaced rollout identities. */
  observe(
    deployments: readonly Record<string, unknown>[],
    revision: string,
    originalRevision?: string,
  ): ReleaseObservation['state'] {
    if (!originalRevision) {
      this.baseline = new Set(
        deployments.map((deployment) => string(deployment.serviceDeploymentArn)),
      );

      return nativeDeploymentState(deployments, revision);
    }

    const baseline = this.baseline;

    if (!baseline) {
      throw new Error('deployment observation requires a captured baseline');
    }

    const candidates = deployments.filter(
      (deployment) => !baseline.has(string(deployment.serviceDeploymentArn)),
    );

    if (!candidates.length) {
      return 'PENDING';
    }

    const rollout = string(candidates[0].serviceDeploymentArn);

    if (candidates.length !== 1 || (this.rollout && rollout !== this.rollout)) {
      throw new Error('ambiguous deployment after captured baseline');
    }

    this.rollout = rollout;

    return nativeDeploymentState(candidates, revision, originalRevision);
  }
}
