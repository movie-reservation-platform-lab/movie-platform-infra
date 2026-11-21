// Parse local commands, wire bounded adapters, and report the execution mode.
import {
  admissionBlockers,
  assertAdmission,
  MINUTE_MS,
  parseSandboxRecord,
  SANDBOX_LIMITS,
} from '@movie-platform/experiment-sandbox';
import { awsCli, launcherScheduler, sleep } from './aws-cli';
import { evaluateOffline, parseCase } from './evaluate';
import { string } from './json';
import { CaseId, runCase, StepId, waitStep, type Scheduler } from './run-case';
import { parseRuntimeConfig } from './runtime-config';
import { runTask } from './task-runtime';
import { createTaskTransport, TaskCommandError } from './task-call';
import { TrialCheckError } from './trial-check-error';
import { probeEndpoint } from './probe';
import { parseDelegateContext } from './delegate';

const help = `Harness trial local CLI (no cloud calls for doctor/evaluate/dry-run)
  evaluate                                  synthetic exact-behavior verification
  doctor [--record <private-json>]           local prerequisite report
  dry-run <good|blocked|bad> --record <file> fixed requests, no AWS action
  <good|blocked|bad> --record <file> --launcher <arn> --profile <profile> [--step gate|watch|release]
  <good|blocked|bad> --record <file> --launcher <arn> --task-credentials [--step gate|watch|release]
  delegate <case> --step gate|watch|release installed delegate context; no record file
  task <gate|watch|release> --case <case>     protected task runtime only

Live commands require authorized sandbox execution, admitted operator record and
the protected launcher ARN. They do not invoke RunTask or PassRole directly.
Blocked/bad live cases exit 1; evaluate succeeds only for the exact expected failures.
`;

export interface CliIo {
  readJson(path: string): Promise<unknown>;
  createScheduler?(region: string, launcherArn: string): Scheduler;
  env: NodeJS.ProcessEnv;
  write(value: string): void;
}

function options(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();

  for (let i = 0; i < args.length; i++) {
    const key = args[i];

    if (!allowed.includes(key) || result.has(key)) {
      throw new Error('unsupported or duplicate argument');
    }

    if (key === '--task-credentials') {
      result.set(key, 'true');
      continue;
    }

    const value = args[++i];

    if (!value || value.startsWith('--')) {
      throw new Error('option requires a value');
    }

    result.set(key, value);
  }

  return result;
}

function required(values: Map<string, string>, key: string): string {
  return string(values.get(key), key);
}

function step(value: string): StepId {
  if (value !== 'gate' && value !== 'watch' && value !== 'release') {
    throw new Error('unknown step');
  }

  return value;
}

export async function cli(args: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;

  if (!command || command === '--help') {
    if (rest.length) {
      throw new Error('unexpected arguments');
    }

    io.write(help);

    return 0;
  }

  if (command === 'evaluate') {
    if (rest.length) {
      throw new Error('evaluate takes no arguments');
    }

    io.write(JSON.stringify(await evaluateOffline(), null, 2));

    return 0;
  }

  if (command === 'delegate') {
    const caseId = parseCase(string(rest[0]));
    const flags = options(rest.slice(1), ['--step']);
    const stepId = step(required(flags, '--step'));
    const context = parseDelegateContext(io.env);

    const scheduler = io.createScheduler
      ? io.createScheduler(context.region, context.launcherArn)
      : launcherScheduler(awsCli(context.region), context.launcherArn);

    const result = await waitStep(
      { experimentId: context.experimentId, caseId, stepId },
      scheduler,
      scheduler.now() + SANDBOX_LIMITS.maxRunMinutes * MINUTE_MS,
    );

    io.write(JSON.stringify({ mode: 'live', ...result }));
    const expectedStatus = stepId === 'watch' ? 'RUNNING' : 'SUCCEEDED';

    return result.status === expectedStatus && Boolean(result.taskArn) ? 0 : 1;
  }

  if (command === 'task') {
    const taskStep = step(string(rest[0]));
    const flags = options(rest.slice(1), ['--case']);
    const caseId = parseCase(required(flags, '--case'));

    if (
      !io.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI &&
      !io.env.AWS_CONTAINER_CREDENTIALS_FULL_URI
    ) {
      throw new Error('task runtime requires isolated container credentials');
    }

    const config = parseRuntimeConfig(
      JSON.parse(string(io.env.TRIAL_RUNTIME_CONFIG, 'TRIAL_RUNTIME_CONFIG')),
    );

    const transport = createTaskTransport(config.region);

    try {
      const result = await runTask(taskStep, caseId, config, {
        call: transport.call,
        now: Date.now,
        sleep,
        probe: probeEndpoint,
      });

      io.write(JSON.stringify({ mode: 'live-task', stepId: taskStep, caseId, ...result }));

      return result.exitCode;
    } finally {
      transport.close();
    }
  }

  if (command === 'doctor') {
    const flags = options(rest, ['--record']);

    if (!flags.has('--record')) {
      io.write(
        JSON.stringify(
          {
            mode: 'offline',
            liveStatus: 'NOT_RUN',
            status: 'RECORD_REQUIRED',
            checks: [
              'evaluate is credential-free',
              'live execution requires admitted operator record and protected launcher',
              'delegate has no direct ECS launch or deployment authority',
            ],
          },
          null,
          2,
        ),
      );

      return 0;
    }

    const record = parseSandboxRecord(await io.readJson(required(flags, '--record')));
    const blockers = admissionBlockers(record, new Date());

    io.write(
      JSON.stringify(
        {
          mode: 'offline',
          liveStatus: 'NOT_RUN',
          status: blockers.length ? 'BLOCKED' : 'LOCAL_RECORD_ADMITTED',
          blockers,
          artifactVerification: 'NOT_RUN',
        },
        null,
        2,
      ),
    );

    return blockers.length ? 1 : 0;
  }

  if (command === 'dry-run') {
    const caseId = parseCase(string(rest[0]));
    const flags = options(rest.slice(1), ['--record']);
    const record = parseSandboxRecord(await io.readJson(required(flags, '--record')));

    io.write(
      JSON.stringify(
        {
          mode: 'offline',
          liveStatus: 'NOT_RUN',
          artifactVerification: 'NOT_RUN',
          requests: (['gate', 'watch', 'release'] as const).map((stepId) => ({
            experimentId: record.id,
            caseId,
            stepId,
          })),
          notes:
            caseId === 'blocked'
              ? 'release request is forbidden after expected gate failure'
              : 'requests are a plan; readiness and trusted results are checked live',
        },
        null,
        2,
      ),
    );

    return 0;
  }

  const caseId: CaseId = parseCase(command);

  const flags = options(rest, [
    '--record',
    '--launcher',
    '--profile',
    '--task-credentials',
    '--step',
  ]);

  const record = parseSandboxRecord(await io.readJson(required(flags, '--record')));

  assertAdmission(record, new Date());
  const arn = required(flags, '--launcher');

  if (
    !new RegExp(
      `^arn:aws:lambda:${record.region}:${record.account.accountId}:function:[a-zA-Z0-9_-]+$`,
    ).test(arn)
  ) {
    throw new Error('launcher must target admitted sandbox account/region');
  }

  const profile = flags.get('--profile');
  const taskCredentials = flags.has('--task-credentials');

  if (Boolean(profile) === taskCredentials) {
    throw new Error('select exactly one explicit credential source');
  }

  if (
    taskCredentials &&
    !io.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI &&
    !io.env.AWS_CONTAINER_CREDENTIALS_FULL_URI
  ) {
    throw new Error('delegate task credentials absent');
  }

  const scheduler = launcherScheduler(awsCli(record.region, profile), arn);

  if (flags.has('--step')) {
    const stepId = step(required(flags, '--step'));

    const result = await waitStep(
      { experimentId: record.id, caseId, stepId },
      scheduler,
      Date.now() + SANDBOX_LIMITS.maxRunMinutes * MINUTE_MS,
    );

    io.write(JSON.stringify({ mode: 'live', ...result }));

    return (stepId === 'watch' ? result.status === 'RUNNING' : result.status === 'SUCCEEDED')
      ? 0
      : 1;
  }

  const result = await runCase(caseId, record.id, scheduler);

  io.write(JSON.stringify(result));

  return result.outcome === 'PASS' ? 0 : 1;
}

/** External failure messages never print arbitrary provider/credential payloads. */
export function safeError(error: unknown): string {
  if (error instanceof TaskCommandError) {
    return `harness-buy-check failed: AWS ${error.operation} failed`;
  }

  if (error instanceof TrialCheckError) {
    return `harness-buy-check failed: ${error.reason}`;
  }

  return 'harness-buy-check failed; inspect protected logs or run doctor/evaluate locally';
}
