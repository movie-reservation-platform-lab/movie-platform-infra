import { parseRuntimeConfig } from '../src/runtime-config';
import { gateExitCode, runTask, RuntimePorts } from '../src/task-runtime';

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

test('blocked gate exits nonzero with no deployment capability', () => {
  expect(gateExitCode('good')).toBe(0);
  expect(gateExitCode('bad')).toBe(0);
  expect(gateExitCode('blocked')).toBe(1);
});

test('runtime rejects injected target overrides and mutable artifacts', () => {
  expect(() => parseRuntimeConfig({ ...config, command: ['sh'] })).toThrow();
  expect(() => parseRuntimeConfig({ ...config, badImage: 'image:latest' })).toThrow();
});

test('release refuses missing observed alarms before any mutation', async () => {
  const operations: string[] = [];

  const ports: RuntimePorts = {
    now: () => 0,
    sleep: async () => {},
    probe: async () => true,
    call: async (service, operation) => {
      operations.push(`${service}.${operation}`);

      if (operation === 'describe-services') {
        return {
          services: [
            {
              taskDefinition: 'old:1',
              deploymentConfiguration: { alarms: { enable: true, alarmNames: [] } },
            },
          ],
        };
      }

      if (operation === 'list-service-deployments') {
        return {
          serviceDeployments: [{ status: 'SUCCESSFUL', createdAt: '2026-10-24T10:00:00Z' }],
        };
      }

      if (operation === 'list-tasks') {
        return { taskArns: ['task1', 'task2'] };
      }

      if (operation === 'describe-tasks') {
        return {
          tasks: [
            ...[1, 2].map((i) => ({
              lastStatus: 'RUNNING',
              taskArn: `task${i}`,
              taskDefinitionArn: 'old:1',
              containers: [{ name: 'recommendation', imageDigest: 'sha256:' + 'a'.repeat(64) }],
              attachments: [{ details: [{ name: 'privateIPv4Address', value: `10.0.0.${i}` }] }],
            })),
            { lastStatus: 'PENDING', taskArn: 'not-started', containers: [] },
          ],
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

      throw new Error('unexpected operation');
    },
  };

  await expect(runTask('release', 'good', config, ports)).rejects.toThrow();
  expect(operations).not.toContain('ecs.update-service');
  expect(operations).not.toContain('ecs.register-task-definition');
  expect(operations).toContain('dynamodb.get-item');
});

test('runtime refuses unobserved artifact identity instead of echoing approved good input', async () => {
  const operations: string[] = [];

  const ports: RuntimePorts = {
    now: () => 0,
    sleep: async () => {},
    probe: async () => true,
    call: async (service, operation) => {
      operations.push(`${service}.${operation}`);

      if (operation === 'describe-services') {
        return { services: [{ taskDefinition: 'old:1' }] };
      }

      if (operation === 'list-service-deployments') {
        return {
          serviceDeployments: [{ status: 'SUCCESSFUL', createdAt: '2026-10-24T10:00:00Z' }],
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
            taskDefinitionArn: 'old:1',
            containers: [{ name: 'recommendation', imageDigest: 'sha256:' + 'c'.repeat(64) }],
            attachments: [{ details: [{ name: 'privateIPv4Address', value: `10.0.0.${i}` }] }],
          })),
        };
      }

      throw new Error('unexpected operation');
    },
  };

  await expect(runTask('release', 'good', config, ports)).rejects.toThrow('not approved good');
  expect(operations).not.toContain('ecs.register-task-definition');
});

test.each(['good', 'bad'] as const)(
  'watcher publishes terminal evidence for %s',
  async (caseId) => {
    let now = 0;
    const publications: string[] = [];
    const updates: Record<string, unknown>[] = [];

    const ports: RuntimePorts = {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      probe: async (_ip, path) => now === 0 || caseId === 'good' || path === '/ready',
      call: async (_service, operation, args) => {
        const terminal = now >= 62_000;
        const revision = now === 0 || (terminal && caseId === 'bad') ? 'old:1' : 'candidate:2';

        switch (operation) {
          case 'describe-services':
            return {
              services: [
                {
                  taskDefinition: revision,
                  deploymentConfiguration: { alarms: { enable: true, alarmNames: ['probe'] } },
                },
              ],
            };
          case 'list-service-deployments':
            return {
              serviceDeployments: [
                {
                  status:
                    now === 0 || (terminal && caseId === 'good')
                      ? 'SUCCESSFUL'
                      : terminal
                        ? 'ROLLBACK_SUCCESSFUL'
                        : 'IN_PROGRESS',
                  createdAt: '2026-10-24T10:00:00Z',
                },
              ],
            };
          case 'list-tasks':
            return { taskArns: ['task1', 'task2'] };
          case 'describe-tasks':
            return {
              tasks: [1, 2].map((task) => ({
                lastStatus: 'RUNNING',
                taskArn: `task${task}`,
                taskDefinitionArn: revision,
                containers: [
                  {
                    name: 'recommendation',
                    imageDigest:
                      'sha256:' +
                      (revision === 'old:1' || caseId === 'good' ? 'a' : 'b').repeat(64),
                  },
                ],
                attachments: [
                  { details: [{ name: 'privateIPv4Address', value: `10.0.0.${task}` }] },
                ],
              })),
            };
          case 'describe-alarms':
            return { MetricAlarms: [{ AlarmName: 'probe', StateValue: 'OK' }] };
          case 'put-metric-data':
            publications.push('metric');

            return {};
          case 'update-item':
            publications.push('state');
            updates.push(JSON.parse(args[args.indexOf('--expression-attribute-values') + 1]));

            return {};
          default:
            throw new Error(`unexpected operation ${operation}`);
        }
      },
    };

    expect(await runTask('watch', caseId, config, ports)).toEqual({
      exitCode: caseId === 'good' ? 0 : 1,
      reason:
        caseId === 'good'
          ? 'candidate probes and completed revision observed'
          : 'ECS returned to original revision',
    });

    expect(
      publications.every((event, index) => event === (index % 2 === 0 ? 'metric' : 'state')),
    ).toBe(true);

    expect(updates.at(-1)).toMatchObject({
      ':candidate': { S: caseId === 'good' ? 'PASS' : 'FAIL' },
      ':verdict': { S: caseId === 'good' ? 'OK' : 'FAIL' },
    });
  },
);

test('watcher observation failure publishes unready failure before propagating', async () => {
  const observedFailure = new Error('observation failed');
  const publications: string[] = [];

  const ports: RuntimePorts = {
    now: () => 0,
    sleep: async () => {},
    probe: async () => true,
    call: async (_service, operation) => {
      if (operation === 'describe-services') {
        throw observedFailure;
      }

      publications.push(operation);

      return {};
    },
  };

  await expect(runTask('watch', 'good', config, ports)).rejects.toBe(observedFailure);
  expect(publications).toEqual(['put-metric-data', 'update-item']);
});
