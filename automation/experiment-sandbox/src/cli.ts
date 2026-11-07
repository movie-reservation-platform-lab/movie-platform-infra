/**
 * The operator CLI: parses arguments, runs one command, prints a JSON summary, and returns
 * the exit code. It is the composition root, where the AWS CLI adapter and the record files
 * are wired into the use cases in `lifecycle.ts`; it makes no decisions of its own.
 *
 * Commands that change AWS only preview unless `--execute` is given, and they hold the
 * record lock while they run.
 */

import {
  admissionBlockers,
  allocationBlockers,
  type SandboxRecord,
} from '@movie-platform/experiment-sandbox';

import { AwsCliSandboxCloud } from './aws-cli';
import { parseCliArguments, type CliArguments } from './cli-arguments';
import {
  admitLease,
  captureControlManifest,
  cleanupSandbox,
  createAccount,
  finalizeControlManifest,
  refreshAccountStatus,
  retireAccount,
  type RecordStore,
  type SandboxCloud,
} from './lifecycle';
import { createPrivateJson, readPrivateJson, readRecord, saveRecord } from './record-file';
import { withRecordLock } from './record-lock';
import { renderSandboxConfig } from './render-config';
import { sampleRecord } from './sample';

/** The command finished and nothing needs attention. */
const EXIT_OK = 0;

/** The command ran, but the operator must act: blockers exist or work is unfinished. */
const EXIT_NEEDS_ATTENTION = 2;

/** One CLI command. */
interface Command {
  /** One line for `--help`. */
  readonly summary: string;
  /** Calls AWS when run with `--execute`; otherwise previews from local data. */
  readonly callsAws: boolean;
  run(args: CliArguments, write: (message: string) => void): Promise<number>;
}

/** What an AWS command does inside the record lock, given the current record. */
type AwsAction = (
  record: SandboxRecord,
  store: RecordStore,
  cloud: SandboxCloud,
  write: (message: string) => void,
) => Promise<SandboxRecord>;

const COMMANDS: Readonly<Record<string, Command>> = {
  sample: offlineCommand('print a synthetic, unapproved record template', runSample),
  prepare: offlineCommand('write that template as a new mode-0600 record outside Git', runPrepare),
  'render-config': offlineCommand(
    'derive the CDK config: --record RECORD --inputs INPUTS --out CONFIG',
    runRenderConfig,
  ),
  inspect: offlineCommand('print account state, blockers and cleanup inventory', (args, write) =>
    runReport(args, write, false),
  ),
  check: offlineCommand('as inspect, but exit 2 while any blocker remains', (args, write) =>
    runReport(args, write, true),
  ),
  'check-configuration': offlineCommand('alias for check', (args, write) =>
    runReport(args, write, true),
  ),
  create: awsCommand(
    'request the sandbox account (management account)',
    async (record, store, cloud) => {
      const blockers = allocationBlockers(record, new Date());

      if (blockers.length > 0) {
        throw new Error(blockers.join('; '));
      }

      return createAccount(record, store, cloud);
    },
  ),
  status: awsCommand('reconcile account creation, or read closure state', (record, store, cloud) =>
    refreshAccountStatus(record, store, cloud),
  ),
  admit: awsCommand(
    'install the protected lease once, after verifying cleanup safeguards',
    async (record, _store, cloud, write) => {
      await admitLease(record, cloud, new Date());

      write(
        'Protected lease conditionally installed. This does not establish workload or trial success.',
      );

      return record;
    },
  ),
  cleanup: awsCommand('invoke protected cleanup and record what remains', (record, store, cloud) =>
    cleanupSandbox(record, store, cloud, new Date()),
  ),
  'capture-controls': awsCommand(
    'record the control stack resources before deleting the stack',
    (record, store, cloud) => captureControlManifest(record, store, cloud, new Date()),
  ),
  'finalize-controls': awsCommand(
    'after stack deletion and evidence export, delete and verify captured leftovers',
    (record, store, cloud) => finalizeControlManifest(record, store, cloud, new Date()),
  ),
  retire: awsCommand('request account closure after verified cleanup', (record, store, cloud) =>
    retireAccount(record, store, cloud),
  ),
};

/**
 * Runs one operator command.
 *
 * @param args -
 * @param write - receives output; tests capture it
 * @returns the process exit code: 0, or 2 when the operator must act
 * @throws Error for invalid arguments or a failed command; `main.ts` prints it and exits 1
 */
export async function runCli(
  args: readonly string[],
  write: (message: string) => void = console.log,
): Promise<number> {
  if (args.length === 0 || args.includes('--help')) {
    write(helpText());

    return EXIT_OK;
  }

  if (!Object.hasOwn(COMMANDS, args[0])) {
    throw new Error('Unknown sandbox command');
  }

  const command = COMMANDS[args[0]];
  const parsed = parseCliArguments(args);

  if (parsed.command !== 'render-config' && (parsed.inputsPath || parsed.outPath)) {
    throw new Error('--inputs/--out are only valid for render-config');
  }

  if (parsed.execute && !command.callsAws) {
    throw new Error(`${parsed.command} is offline only and does not accept --execute`);
  }

  return command.run(parsed, write);
}

function helpText(): string {
  const lines = Object.entries(COMMANDS).map(
    ([name, command]) => `  ${name.padEnd(18)} ${command.summary}`,
  );

  return [
    'Usage: sandbox:experiment -- <command> --record /absolute/private/record.json [--execute]',
    '',
    ...lines,
    '',
    'AWS commands only preview without --execute. Provision the control and workload stacks',
    'separately with the reviewed CDK app. No command claims deployment or trial success.',
  ].join('\n');
}

function offlineCommand(summary: string, run: Command['run']): Command {
  return { summary, callsAws: false, run };
}

/**
 * An AWS command: a preview without `--execute`; with it, the action runs under the record
 * lock and its result is printed as a summary.
 */
function awsCommand(summary: string, action: AwsAction): Command {
  return {
    summary,
    callsAws: true,
    run: async (args, write) => {
      if (!args.execute) {
        return runReport(
          args,
          write,
          false,
          `${args.command} has not executed; explicit --execute and validated target required`,
        );
      }

      const recordPath = requireRecordPath(args);

      return withRecordLock(recordPath, async () => {
        const store: RecordStore = { save: (next) => saveRecord(recordPath, next) };
        const record = await action(readRecord(recordPath), store, new AwsCliSandboxCloud(), write);

        write(JSON.stringify(executionSummary(record), null, 2));

        return needsAttention(args.command, record) ? EXIT_NEEDS_ATTENTION : EXIT_OK;
      });
    },
  };
}

async function runSample(_args: CliArguments, write: (message: string) => void): Promise<number> {
  write(JSON.stringify(sampleRecord(new Date()), null, 2));

  return EXIT_OK;
}

async function runPrepare(args: CliArguments, write: (message: string) => void): Promise<number> {
  saveRecord(requireRecordPath(args), sampleRecord(new Date()), true);

  write(
    'Prepared synthetic unapproved record. Replace operator identity, unique account correlation, artifacts and evidence locally before allocation.',
  );

  return EXIT_OK;
}

async function runRenderConfig(
  args: CliArguments,
  write: (message: string) => void,
): Promise<number> {
  const recordPath = requireRecordPath(args);

  if (!args.inputsPath || !args.outPath) {
    throw new Error('Offline render-config requires --inputs and --out');
  }

  const config = renderSandboxConfig(readRecord(recordPath), readPrivateJson(args.inputsPath));

  createPrivateJson(args.outPath, config);

  write(
    'Private CDK config rendered; app synth validates it independently. No cloud operation executed.',
  );

  return EXIT_OK;
}

/**
 * Prints the record's state and every allocation and admission blocker, from local data only.
 *
 * @param gateOnBlockers - exit 2 while any blocker remains (the `check` command)
 * @param preview - shown when an AWS command ran without `--execute`
 */
async function runReport(
  args: CliArguments,
  write: (message: string) => void,
  gateOnBlockers: boolean,
  preview?: string,
): Promise<number> {
  const record = readRecord(requireRecordPath(args));
  const now = new Date();

  const report = {
    experimentId: record.id,
    accountState: record.account.state,
    allocationBlockers: allocationBlockers(record, now),
    admissionBlockers: admissionBlockers(record, now),
    cleanup: record.inventory,
    preview,
  };

  write(JSON.stringify(report, null, 2));

  const hasBlockers = report.allocationBlockers.length > 0 || report.admissionBlockers.length > 0;

  return gateOnBlockers && hasBlockers ? EXIT_NEEDS_ATTENTION : EXIT_OK;
}

function requireRecordPath(args: CliArguments): string {
  if (!args.recordPath) {
    throw new Error('Absolute --record path required');
  }

  return args.recordPath;
}

/** What an AWS command prints after it ran: the record fields the operator acts on next. */
function executionSummary(record: SandboxRecord) {
  const { inventory } = record;

  return {
    experimentId: record.id,
    accountState: record.account.state,
    workloadsRemoved: inventory.workloadsRemoved,
    accessRevoked: inventory.accessRevoked,
    remainingResources: inventory.resources,
    cleanupStatus: inventory.cleanupStatus,
    cleanupBlockers: inventory.cleanupBlockers,
    controlManifest: inventory.retiredControls,
  };
}

/** Whether the command left work for the operator: unfinished cleanup or finalization. */
function needsAttention(command: string, record: SandboxRecord): boolean {
  if (command === 'finalize-controls') {
    return !record.inventory.retiredControls?.verifiedAbsentAt;
  }

  if (command === 'cleanup') {
    return !record.inventory.workloadsRemoved;
  }

  return record.account.state === 'unknown';
}
