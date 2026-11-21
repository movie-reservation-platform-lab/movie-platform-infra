import { parseRuntimeConfig } from '../src/runtime-config';
import { runTask, RuntimePorts } from '../src/task-runtime';

const image = '111111111111.dkr.ecr.eu-central-1.amazonaws.com/recommendation@sha256:';

const config = parseRuntimeConfig({
  experimentId: 'synthetic',
  region: 'eu-central-1',
  cluster: 'cluster',
  service: 'service',
  recipeTaskDefinitionArn: 'recipe:1',
  containerName: 'recommendation',
  goodImage: image + 'a'.repeat(64),
  badImage: image + 'b'.repeat(64),
  stateTableName: 'state',
  probeAlarmName: 'probe',
});

function baseline(
  options: {
    revision?: string;
    alarmState?: string;
    missingAlarm?: boolean;
  } = {},
) {
  let currentRevision = options.revision ?? config.recipeTaskDefinitionArn;
  let enabled = false;
  const operations: string[] = [];
  const updates: unknown[] = [];

  const ports: RuntimePorts = {
    now: () => 0,
    sleep: async () => {},
    probe: async () => true,
    call: async (...[service, operation, input]) => {
      operations.push(`${service}.${operation}`);

      if (operation === 'describe-services') {
        return {
          services: [
            {
              taskDefinition: currentRevision,
              deploymentConfiguration: {
                strategy: 'CANARY',
                alarms: {
                  enable: enabled,
                  rollback: true,
                  alarmNames: ['probe'],
                },
              },
            },
          ],
        };
      }

      if (operation === 'list-service-deployments') {
        return {
          serviceDeployments: [
            {
              serviceDeploymentArn: currentRevision,
              status: 'SUCCESSFUL',
              createdAt: '2026-10-24T10:00:00Z',
            },
          ],
        };
      }

      if (operation === 'list-tasks') {
        return { taskArns: ['task1', 'task2'] };
      }

      if (operation === 'describe-tasks') {
        return {
          tasks: [1, 2].map((i) => ({
            lastStatus: 'RUNNING',
            taskArn: `task${i}`,
            taskDefinitionArn: currentRevision,
            containers: [
              {
                name: 'recommendation',
                imageDigest: 'sha256:' + 'a'.repeat(64),
              },
            ],
            attachments: [
              {
                details: [{ name: 'privateIPv4Address', value: `10.0.0.${i}` }],
              },
            ],
          })),
        };
      }

      if (operation === 'get-item') {
        return {
          Item: {
            ready: { BOOL: true },
            heartbeatAt: { N: '0' },
            verdict: { S: 'OK' },
            candidateVerdict: { S: 'PASS' },
          },
        };
      }

      if (operation === 'describe-alarms') {
        expect(input).toEqual({
          AlarmNames: ['probe'],
          AlarmTypes: ['MetricAlarm'],
        });

        if (options.missingAlarm) {
          return { MetricAlarms: [] };
        }

        return {
          MetricAlarms: [{ AlarmName: 'probe', StateValue: options.alarmState ?? 'OK' }],
        };
      }

      if (operation === 'describe-task-definition') {
        return {
          taskDefinition: {
            family: 'recipe',
            containerDefinitions: [{ name: 'recommendation', image: config.goodImage }],
          },
          tags: [],
        };
      }

      if (operation === 'register-task-definition') {
        return {
          taskDefinition: { taskDefinitionArn: 'candidate:2' },
        };
      }

      if (operation === 'update-service') {
        updates.push(input.deploymentConfiguration);
        currentRevision = 'candidate:2';
        enabled = true;

        return {};
      }

      throw new Error('unexpected operation');
    },
  };

  return { ports, operations, updates };
}

test('untouched bootstrap with actual OK alarms and fresh healthy watch arms first candidate', async () => {
  const fixture = baseline();
  const result = await runTask('release', 'good', config, fixture.ports);

  expect(result).toMatchObject({
    exitCode: 0,
    reverted: false,
    revision: 'candidate:2',
  });

  expect(fixture.updates).toEqual([
    {
      strategy: 'CANARY',
      alarms: { enable: true, rollback: true, alarmNames: ['probe'] },
    },
  ]);

  expect(
    fixture.operations.filter((operation) => operation === 'cloudwatch.describe-alarms').length,
  ).toBeGreaterThanOrEqual(4);
});

test('disabled alarms on any nonbootstrap revision reject before registration or update', async () => {
  const fixture = baseline({ revision: 'previous-release:3' });

  await expect(runTask('release', 'good', config, fixture.ports)).rejects.toThrow();
  expect(fixture.operations).not.toContain('ecs.register-task-definition');
  expect(fixture.updates).toEqual([]);
});

test('bootstrap exception still observes and blocks pending actual alarms', async () => {
  const fixture = baseline({ alarmState: 'INSUFFICIENT_DATA' });

  await expect(runTask('release', 'good', config, fixture.ports)).rejects.toThrow();
  expect(fixture.operations).toContain('cloudwatch.describe-alarms');
  expect(fixture.operations).not.toContain('ecs.register-task-definition');
  expect(fixture.updates).toEqual([]);
});

test('an absent named metric alarm blocks registration and service update', async () => {
  const fixture = baseline({ missingAlarm: true });

  await expect(runTask('release', 'good', config, fixture.ports)).rejects.toThrow();
  expect(fixture.operations).not.toContain('ecs.register-task-definition');
  expect(fixture.updates).toEqual([]);
});
