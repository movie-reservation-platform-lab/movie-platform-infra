import { parseArgs } from 'node:util';
import { PreflightFailure, fail } from './preflight-error';
import { runPreflight } from './preflight';
import { runSelfTest } from './self-test';

const CLI_OPTIONS = {
  help: {
    type: 'boolean',
    short: 'h',
  },
  'self-test': {
    type: 'boolean',
  },
} as const;

const USAGE = [
  'Usage: aws-account-preflight [--self-test]',
  '',
  'Read-only guard for workstation AWS mutations in the demo account.',
  '',
  'The target defaults to:',
  '  ${XDG_CONFIG_HOME:-$HOME/.config}/movie-platform/aws-target.json',
  '',
  'Set MOVIE_PLATFORM_AWS_TARGET_FILE to an absolute path to select a different',
  'target file. The operator-owned file must deny all group and other access and',
  'contain exactly this JSON object shape:',
  '',
  '  {',
  '    "profile": "movie-platform-demo",',
  '    "region": "eu-central-1",',
  '    "accountId": "<12-digit-account-id>",',
  '    "expectedRoleName": "AWSReservedSSO_AdministratorAccess_<16-hex-suffix>"',
  '  }',
  '',
  'The command parses this file as inert data, rejects alternate credential',
  'providers, calls STS GetCallerIdentity, and fails unless the profile, account,',
  'Region, permission set, and generated Identity Center role all agree.',
  '',
].join('\n');

interface CliOptions {
  readonly help: boolean;
  readonly selfTest: boolean;
}

/** Minimal output boundary used by the CLI and its isolated tests. */
interface CliStreams {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const PROCESS_STREAMS: CliStreams = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/**
 * Run the command-line boundary without leaking unexpected exception details.
 *
 * This function is the automation package's intentionally small public seam;
 * configuration, filesystem, and AWS implementation details remain internal.
 */
export function runCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  streams: CliStreams = PROCESS_STREAMS,
): number {
  try {
    const options = parseCliOptions(arguments_);

    if (options.help) {
      streams.stdout(USAGE);
      return 0;
    }
    if (options.selfTest) {
      runSelfTest();
      streams.stdout('AWS account preflight self-test passed\n');
      return 0;
    }

    streams.stdout(runPreflight(environment));
    return 0;
  } catch (error: unknown) {
    const message = error instanceof PreflightFailure ? error.message : 'unexpected internal error';
    streams.stderr(`AWS account preflight failed: ${message}\n`);
    return 1;
  }
}

function parseCliOptions(arguments_: readonly string[]): CliOptions {
  try {
    const { values } = parseArgs({
      args: [...arguments_],
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: false,
    });

    if (values.help === true && values['self-test'] === true) {
      fail('--help and --self-test cannot be combined');
    }

    return Object.freeze({
      help: values.help ?? false,
      selfTest: values['self-test'] ?? false,
    });
  } catch (error: unknown) {
    if (error instanceof PreflightFailure) {
      throw error;
    }
    fail('invalid arguments; run with --help for usage');
  }
}
