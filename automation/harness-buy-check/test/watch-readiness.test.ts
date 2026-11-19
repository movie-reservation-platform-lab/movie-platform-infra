// Exercise observer publication ordering with an interleaved release-side read.
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

test('release-side readiness reads stay true between metric publication and the next successful alarm response', async () => {
  let currentTime = 0;
  let publishedReady = false;
  let alarmReads = 0;
  let readinessDuringSecondAlarmRead: boolean | undefined;
  const stopAfterRead = new Error('bounded fake observer complete');

  const ports: RuntimePorts = {
    now: () => currentTime,
    sleep: async (milliseconds) => {
      if (alarmReads >= 2) {
        throw stopAfterRead;
      }

      currentTime += milliseconds;
    },
    probe: async () => true,
    call: async (_service, operation, args) => {
      if (operation === 'describe-services') {
        return {
          services: [
            {
              taskDefinition: 'recipe:1',
              deploymentConfiguration: { alarms: { enable: false, alarmNames: ['probe'] } },
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
          tasks: [1, 2].map((taskNumber) => ({
            taskArn: `task${taskNumber}`,
            taskDefinitionArn: 'recipe:1',
            lastStatus: 'RUNNING',
            containers: [{ name: 'recommendation', imageDigest: 'sha256:' + 'a'.repeat(64) }],
            attachments: [
              { details: [{ name: 'privateIPv4Address', value: `10.0.0.${taskNumber}` }] },
            ],
          })),
        };
      }

      if (operation === 'put-metric-data') {
        return {};
      }

      if (operation === 'update-item') {
        const values = JSON.parse(args[args.indexOf('--expression-attribute-values') + 1]);

        publishedReady = values[':ready'].BOOL;

        return {};
      }

      if (operation === 'describe-alarms') {
        alarmReads += 1;

        if (alarmReads === 2) {
          readinessDuringSecondAlarmRead = publishedReady;
        }

        return { MetricAlarms: [{ AlarmName: 'probe', StateValue: 'OK' }] };
      }

      throw new Error('unexpected observer operation');
    },
  };

  await expect(runTask('watch', 'good', config, ports)).rejects.toBe(stopAfterRead);
  expect(readinessDuringSecondAlarmRead).toBe(true);
});
