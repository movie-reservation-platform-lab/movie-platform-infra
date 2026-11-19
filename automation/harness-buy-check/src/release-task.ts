/** Connects the release decision workflow to ECS registration, service updates and observations. */
import type { CaseId } from './run-case';
import type { RuntimeConfig } from './runtime-config';
import type { RuntimePorts, TaskResult } from './runtime-types';
import { createTaskAws, requireApprovedAlarmSettings, type TaskAws } from './task-aws';
import { releaseCandidate, type ReleasePort, type ReleaseObservation } from './release';
import { renderRecipe } from './recipe';
import { array, object, string } from './json';
import { assertAllAlarmsOk, assertWatchReady } from './watch';

/**
 * Verifies the approved good baseline, then runs the generic release workflow through AWS.
 *
 * @param config - validated workload targets, recipe and approved image pair
 * @param caseId - scenario selecting the good image or deliberately bad canary
 * @param ports - AWS transport, clock, delay and probes supplied to the task
 * @returns nonzero for failed releases, including successful rollback; attaches baseline
 *   revision and digest only when rollback was verified
 * @throws Error when the baseline artifact is unapproved or an AWS/safeguard check fails
 */
export async function runReleaseTask(
  config: RuntimeConfig,
  caseId: CaseId,
  ports: RuntimePorts,
): Promise<TaskResult> {
  const aws = createTaskAws(config, caseId, ports);
  const original = await aws.observe();

  if (original.digest !== config.goodImage.split('@')[1]) {
    throw new Error('original running artifact is not approved good image');
  }

  // Reuse S1 render/register/update behavior as a small tested library, preserving its recipe.
  const image = caseId === 'bad' ? config.badImage : config.goodImage;

  const releasePort = createReleasePort({ config, ports, aws, image, original });
  const result = await releaseCandidate(releasePort, image.split('@')[1], original);

  return {
    exitCode: result.outcome === 'PASS' ? 0 : 1,
    reason: result.reason,
    reverted: result.reverted,
    revision: result.revision,
    ...(result.reverted
      ? {
          originalTaskDefinitionArn: original.taskDefinitionArn,
          observedOriginalDigest: original.digest,
        }
      : {}),
  };
}

/** Wires the generic release workflow to this task's fixed AWS targets and candidate image. */
function createReleasePort(context: ReleaseTaskContext): ReleasePort {
  const { config, ports, aws, image, original } = context;

  return {
    now: ports.now,
    sleep: ports.sleep,
    watch: aws.watch,
    alarms: aws.alarms,
    verdict: aws.verdict,
    observe: () => aws.observe(original.taskDefinitionArn),
    register: () => registerCandidateRevision(config, ports, image),
    update: (revision) => updateCandidateService(config, ports, aws, revision),
  };
}

/** Renders the approved recipe, sets the experiment tag and registers its candidate revision. */
async function registerCandidateRevision(
  config: RuntimeConfig,
  ports: RuntimePorts,
  image: string,
): Promise<string> {
  const recipe = await ports.call('ecs', 'describe-task-definition', [
    '--task-definition',
    config.recipeTaskDefinitionArn,
    '--include',
    'TAGS',
  ]);

  const rendered = renderRecipe(recipe, config.containerName, image);

  rendered.tags = [
    ...array(rendered.tags)
      .map((value) => object(value))
      .filter((tag) => tag.key !== 'ExperimentId'),
    { key: 'ExperimentId', value: config.experimentId },
  ];

  const response = await ports.call('ecs', 'register-task-definition', [
    '--cli-input-json',
    JSON.stringify(rendered),
  ]);

  return string(object(response.taskDefinition).taskDefinitionArn);
}

/** Rechecks watcher/alarms before updating the service with monitoring and rollback enabled. */
async function updateCandidateService(
  config: RuntimeConfig,
  ports: RuntimePorts,
  aws: TaskAws,
  revision: string,
): Promise<void> {
  const current = await aws.service();
  const settings = object(current.deploymentConfiguration);
  const alarms = requireApprovedAlarmSettings(current, config);

  // Bootstrap skips monitoring only before any watcher exists. The first
  // candidate arms it after fresh watcher and actual alarm observations.
  assertWatchReady(await aws.watch(), ports.now());
  assertAllAlarmsOk(await aws.alarms());

  await ports.call('ecs', 'update-service', [
    '--cluster',
    config.cluster,
    '--service',
    config.service,
    '--task-definition',
    revision,
    '--deployment-configuration',
    JSON.stringify({ ...settings, alarms: { ...alarms, enable: true, rollback: true } }),
  ]);
}

/** Fixed dependencies and identities used to assemble one release task's port. */
interface ReleaseTaskContext {
  config: RuntimeConfig;
  ports: RuntimePorts;
  aws: TaskAws;
  image: string;
  original: ReleaseObservation;
}
