/**
 * Adapts ECS, CloudWatch and DynamoDB observations to the trial's release/watch contracts.
 * Calls use injected transport and preserve exact task identity and metric publication order.
 */
import { SANDBOX_LIMITS, SANDBOX_PROBE_METRIC } from '@movie-platform/experiment-sandbox';
import type { RuntimeConfig } from './runtime-config';
import type { RuntimePorts } from './runtime-types';
import type { CaseId } from './run-case';
import type { ReleaseObservation } from './release';
import type { Verdict, WatchReadiness } from './watch';
import { array, object, string } from './json';
import { nativeDeploymentState } from './native-deployment';

/**
 * Binds observation and publication operations to one experiment case.
 *
 * @param config - validated ECS, CloudWatch and DynamoDB target identities
 * @param caseId - scenario used to identify the watcher row
 * @param ports - AWS transport and observation clock
 * @returns case-scoped AWS operations; constructing the adapter performs no I/O
 */
export function createTaskAws(config: RuntimeConfig, caseId: CaseId, ports: RuntimePorts) {
  const key = JSON.stringify({ experimentId: { S: `${config.experimentId}#${caseId}#watch` } });

  /** Reads exactly one configured service and refuses AWS-reported observation failures. */
  async function readService(): Promise<Record<string, unknown>> {
    const response = await ports.call('ecs', 'describe-services', [
      '--cluster',
      config.cluster,
      '--services',
      config.service,
    ]);

    if (array(response.failures ?? []).length) {
      throw new Error('service observation failed');
    }

    const services = array(response.services);

    if (services.length !== 1) {
      throw new Error('expected exact service');
    }

    return object(services[0]);
  }

  /** Reads configured metric/composite alarms, marking unreturned names as MISSING. */
  async function readAlarms(): Promise<Record<string, string>> {
    const watched = requireApprovedAlarmSettings(await readService(), config);
    const names = array(watched.alarmNames).map((value) => string(value));

    const response = await ports.call('cloudwatch', 'describe-alarms', [
      '--alarm-names',
      ...names,
      '--alarm-types',
      'MetricAlarm',
      'CompositeAlarm',
    ]);

    const observed = [
      ...array(response.MetricAlarms ?? []),
      ...array(response.CompositeAlarms ?? []),
    ].map((value) => object(value));

    return Object.fromEntries(
      names.map((name) => [
        name,
        string(observed.find((alarm) => alarm.AlarmName === name)?.StateValue ?? 'MISSING'),
      ]),
    );
  }

  /** Lists at most four workload tasks and extracts identities only from running tasks. */
  async function readRunningTasks(): Promise<ObservedTask[]> {
    const listing = await ports.call('ecs', 'list-tasks', [
      '--cluster',
      config.cluster,
      '--service-name',
      config.service,
      '--desired-status',
      'RUNNING',
    ]);

    const arns = array(listing.taskArns).map((value) => string(value));

    if (!arns.length) {
      return [];
    }

    if (arns.length > 4) {
      throw new Error('task count exceeds approved envelope');
    }

    const response = await ports.call('ecs', 'describe-tasks', [
      '--cluster',
      config.cluster,
      '--tasks',
      ...arns,
    ]);

    if (array(response.failures ?? []).length) {
      throw new Error('task identity observation failed');
    }

    return array(response.tasks)
      .map((value) => object(value))
      .filter((task) => task.lastStatus === 'RUNNING')
      .map((task) => readTaskIdentity(task, config.containerName));
  }

  /** Combines bounded deployment history with two-task steadiness and observed image identity. */
  async function observeDeployment(originalRevision?: string): Promise<ReleaseObservation> {
    const current = await readService();
    const revision = string(current.taskDefinition);

    const listing = await ports.call('ecs', 'list-service-deployments', [
      '--cluster',
      config.cluster,
      '--service',
      config.service,
      '--max-items',
      '20',
    ]);

    if (listing.NextToken || listing.nextToken) {
      throw new Error('native deployment history exceeds trial bounds');
    }

    const nativeState = nativeDeploymentState(
      array(listing.serviceDeployments).map((value) => object(value)),
      revision,
      originalRevision,
    );

    const running = await readRunningTasks();
    const exact = running.filter((task) => task.revision === revision);
    const tasksSteady = exact.length === 2 && running.length === 2;

    const digest =
      exact.length && new Set(exact.map((task) => task.digest)).size === 1 ? exact[0].digest : '';

    return {
      taskDefinitionArn: revision,
      digest,
      state:
        (nativeState === 'COMPLETED' || nativeState === 'REVERTED') && !tasksSteady
          ? 'ACTIVE'
          : nativeState,
    };
  }

  /** Reads the case's watcher row with DynamoDB strong consistency. */
  async function readWatchItem(): Promise<Record<string, unknown>> {
    const response = await ports.call('dynamodb', 'get-item', [
      '--table-name',
      config.stateTableName,
      '--key',
      key,
      '--consistent-read',
    ]);

    return object(response.Item, 'watcher observation');
  }

  /** Combines the published readiness/health flags with current alarm observations. */
  async function readWatchReadiness(): Promise<WatchReadiness> {
    const item = await readWatchItem();

    return {
      ready: object(item.ready).BOOL === true && object(item.verdict).S === 'OK',
      heartbeatAt: Number(string(object(item.heartbeatAt).N)),
      alarmStates: await readAlarms(),
    };
  }

  /** Reads a recognized candidate verdict only while its heartbeat is fresh. */
  async function readCandidateVerdict(): Promise<Verdict> {
    const item = await readWatchItem();
    const heartbeatAt = Number(string(object(item.heartbeatAt).N));

    if (
      !Number.isFinite(heartbeatAt) ||
      ports.now() < heartbeatAt ||
      ports.now() - heartbeatAt > SANDBOX_LIMITS.watchHeartbeatMaxAgeSeconds * 1000
    ) {
      throw new Error('watch verdict stale');
    }

    const result = string(object(item.candidateVerdict).S);

    if (result !== 'PASS' && result !== 'FAIL' && result !== 'PENDING') {
      throw new Error('invalid candidate verdict');
    }

    return result;
  }

  /** Publishes the probe metric before updating watcher state and heartbeat in DynamoDB. */
  async function publishWatchState(
    ready: boolean,
    result: Verdict,
    health: 'OK' | 'FAIL',
  ): Promise<void> {
    await ports.call('cloudwatch', 'put-metric-data', [
      '--namespace',
      SANDBOX_PROBE_METRIC.namespace,
      '--metric-data',
      JSON.stringify([
        {
          MetricName: SANDBOX_PROBE_METRIC.metricName,
          Dimensions: [{ Name: 'ExperimentId', Value: config.experimentId }],
          Value: health === 'FAIL' ? 1 : 0,
          Unit: 'Count',
          StorageResolution: 1,
        },
      ]),
    ]);

    await ports.call('dynamodb', 'update-item', [
      '--table-name',
      config.stateTableName,
      '--key',
      key,
      '--update-expression',
      'SET ready = :ready, heartbeatAt = :heartbeat, verdict = :verdict, candidateVerdict = :candidate',
      '--expression-attribute-values',
      JSON.stringify({
        ':ready': { BOOL: ready },
        ':heartbeat': { N: String(ports.now()) },
        ':verdict': { S: health },
        ':candidate': { S: result },
      }),
    ]);
  }

  return {
    service: readService,
    alarms: readAlarms,
    tasks: readRunningTasks,
    observe: observeDeployment,
    watch: readWatchReadiness,
    verdict: readCandidateVerdict,
    publish: publishWatchState,
  };
}

/**
 * Requires the configured probe alarm and enabled deployment monitoring, except on the
 * untouched bootstrap revision. That exception still requires observing actual alarms.
 *
 * @param current - observed ECS service, including deployment configuration
 * @param config - fixed recipe revision and required probe alarm
 * @returns existing alarm settings for observation or a guarded service update
 * @throws Error when deployment alarm configuration is missing or unexpectedly disabled
 */
export function requireApprovedAlarmSettings(
  current: Record<string, unknown>,
  config: RuntimeConfig,
): Record<string, unknown> {
  const settings = object(current.deploymentConfiguration);
  const alarms = object(settings.alarms);
  const names = array(alarms.alarmNames).map((value) => string(value));

  const untouchedBootstrap =
    current.taskDefinition === config.recipeTaskDefinitionArn && alarms.enable === false;

  if (
    (!untouchedBootstrap && alarms.enable !== true) ||
    !names.length ||
    !names.includes(config.probeAlarmName)
  ) {
    throw new Error('missing enabled deployment alarms outside untouched bootstrap');
  }

  return alarms;
}

/** Extracts the selected container's image and task address; refuses missing/ambiguous containers. */
function readTaskIdentity(task: Record<string, unknown>, containerName: string): ObservedTask {
  const containers = array(task.containers).map((value) => object(value));
  const selected = containers.filter((container) => container.name === containerName);

  if (selected.length !== 1) {
    throw new Error('missing exact workload container');
  }

  const details = array(task.attachments)
    .flatMap((value) => array(object(value).details ?? []))
    .map((value) => object(value));

  return {
    arn: string(task.taskArn),
    revision: string(task.taskDefinitionArn),
    digest: string(selected[0].imageDigest),
    ip: string(details.find((detail) => detail.name === 'privateIPv4Address')?.value),
  };
}

/** Running workload task identity and private address, extracted from ECS observations. */
export interface ObservedTask {
  arn: string;
  revision: string;
  digest: string;
  ip: string;
}

/** AWS operations bound to one experiment case and injected transport. */
export type TaskAws = ReturnType<typeof createTaskAws>;
