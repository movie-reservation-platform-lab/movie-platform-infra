import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { TaskCall } from '../../src/task-call';
import type { RuntimeConfig } from '../../src/runtime-config';
import type { RuntimePorts } from '../../src/runtime-types';

const repository = 'registry.example/recommendation@sha256:';
const BASELINE = 'recipe:1';
const CANDIDATE = 'recipe:2';
const AWS_LATENCY_MS = 2500;
const BAKE_MS = 10 * 60_000;

export const rolloutConfig: RuntimeConfig = {
  experimentId: 'timing-trial',
  region: 'eu-central-1',
  cluster: 'trial',
  service: 'recommendation',
  recipeTaskDefinitionArn: BASELINE,
  goodImage: repository + 'a'.repeat(64),
  badImage: repository + 'b'.repeat(64),
  containerName: 'recommendation',
  stateTableName: 'observations',
  probeAlarmName: 'probe',
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deployment(id: string, status: string, time: number) {
  return {
    serviceDeploymentArn: 'deployment/' + id,
    targetServiceRevisionArn: 'service-revision/' + id,
    createdAt: new Date(time).toISOString(),
    status,
  };
}

type WatchItem = Record<'ready' | 'heartbeatAt' | 'verdict' | 'candidateVerdict', AttributeValue>;

/** Models the ECS list lag and sequential CLI latency seen during the fourth lease. */
export function timedEcsRollout(caseId: 'good' | 'bad') {
  const config = rolloutConfig;
  const startedAt = Date.now();

  const rowKey = {
    experimentId: { S: `${config.experimentId}#${caseId}#watch` },
  };

  const previous = deployment(
    'previous',
    caseId === 'bad' ? 'ROLLBACK_SUCCESSFUL' : 'SUCCESSFUL',
    startedAt,
  );

  const probes = new Map<string, { at: number; ok: boolean }[]>();
  const heartbeatAgesAtRefresh: number[] = [];
  let firstFailedVerdictAt: number | undefined;
  let watch: WatchItem | undefined;
  let candidateImage: string | undefined;
  let updatedAt: number | undefined;
  let alarmAt: number | undefined;

  function deploymentState() {
    if (updatedAt === undefined) {
      return 'BASELINE';
    }

    if (alarmAt !== undefined) {
      return Date.now() - alarmAt < 60_000 ? 'ROLLBACK_IN_PROGRESS' : 'ROLLBACK_SUCCESSFUL';
    }

    return Date.now() - updatedAt >= BAKE_MS ? 'SUCCESSFUL' : 'IN_PROGRESS';
  }

  function serviceRevision() {
    // After terminal rollback, the service pointer and running tasks converge later.
    const restored = alarmAt !== undefined && Date.now() - alarmAt >= 80_000;

    return updatedAt === undefined || restored ? BASELINE : CANDIDATE;
  }

  function task(id: number) {
    const baseline = id < 3;
    const image = baseline ? config.goodImage : candidateImage;

    if (!image) {
      throw new Error('Candidate tasks exist before registration');
    }

    return {
      taskArn: 'task/' + id,
      taskDefinitionArn: baseline ? BASELINE : CANDIDATE,
      lastStatus: 'RUNNING',
      containers: [{ name: config.containerName, imageDigest: image.split('@')[1] }],
      attachments: [{ details: [{ name: 'privateIPv4Address', value: '10.0.0.' + id }] }],
    };
  }

  function runningIds(): number[] {
    if (serviceRevision() === BASELINE) {
      return [1, 2];
    }

    return deploymentState() === 'SUCCESSFUL' ? [3, 4] : [1, 2, 3, 4];
  }

  const call: TaskCall = async (...[_service, operation, input]) => {
    await sleep(AWS_LATENCY_MS);

    switch (operation) {
      case 'describe-services':
        return {
          services: [
            {
              taskDefinition: serviceRevision(),
              deploymentConfiguration: {
                alarms: {
                  enable: true,
                  rollback: true,
                  alarmNames: [config.probeAlarmName],
                },
              },
            },
          ],
        };

      case 'list-service-deployments': {
        // The service already points to the candidate when only prior history is visible.
        const visible = updatedAt !== undefined && Date.now() - updatedAt >= 30_000;

        return {
          serviceDeployments: visible
            ? [deployment('current', deploymentState(), updatedAt!), previous]
            : [previous],
        };
      }

      case 'list-tasks':
        return { taskArns: runningIds().map((id) => 'task/' + id) };
      case 'describe-tasks':
        return {
          tasks: input.tasks!.map((arn) => task(Number(arn.slice(5)))),
        };
      case 'describe-task-definition':
        return {
          taskDefinition: {
            family: 'recipe',
            containerDefinitions: [{ name: config.containerName, image: config.goodImage }],
          },
        };

      case 'register-task-definition': {
        candidateImage = input.containerDefinitions![0].image;

        return { taskDefinition: { taskDefinitionArn: CANDIDATE } };
      }

      case 'update-service':
        expect(input.taskDefinition).toBe(CANDIDATE);
        updatedAt = Date.now();

        return {};
      case 'describe-alarms':
        return {
          MetricAlarms: [
            {
              AlarmName: config.probeAlarmName,
              StateValue: alarmAt === undefined ? 'OK' : 'ALARM',
            },
          ],
        };

      case 'put-metric-data': {
        const [metric] = input.MetricData!;

        if (deploymentState() === 'IN_PROGRESS' && metric.Value === 1) {
          alarmAt = Date.now();
        }

        return {};
      }

      case 'update-item': {
        expect(input.Key).toEqual(rowKey);
        const attrs = input.ExpressionAttributeValues!;

        if (watch?.ready.BOOL) {
          heartbeatAgesAtRefresh.push(Date.now() - Number(watch.heartbeatAt.N));
        }

        if (firstFailedVerdictAt === undefined && attrs[':candidate'].S === 'FAIL') {
          firstFailedVerdictAt = Date.now();
        }

        watch = {
          ready: attrs[':ready'],
          verdict: attrs[':verdict'],
          heartbeatAt: attrs[':heartbeat'],
          candidateVerdict: attrs[':candidate'],
        };

        return {};
      }

      case 'get-item':
        expect(input.Key).toEqual(rowKey);
        expect(input.ConsistentRead).toBe(true);

        return { Item: watch };
      default:
        throw new Error('Unexpected operation ' + operation);
    }
  };

  const ports: RuntimePorts = {
    now: Date.now,
    sleep,
    call,
    probe: async (ip, path) => {
      await sleep(40);

      if (path === '/recommendations' && (ip === '10.0.0.3' || ip === '10.0.0.4')) {
        const samples = probes.get(ip) ?? [];

        const ok = candidateImage !== config.badImage || samples.length % 2 === 0;

        samples.push({ at: Date.now(), ok });
        probes.set(ip, samples);

        return ok;
      }

      return true;
    },
  };

  return {
    ports,
    ready: () => watch?.ready.BOOL,
    probes,
    heartbeatAgesAtRefresh,
    firstFailedVerdictAt: () => firstFailedVerdictAt,
    updatedAt: () => updatedAt,
    state: deploymentState,
  };
}
