import { describeError } from '../core/redaction';
import { EXIT_CODES, runCli } from './cli';
import { PRODUCTION_DEPENDENCIES } from './production-dependencies';

const streams = {
  stdout: (text: string) => process.stdout.write(text),
  stderr: (text: string) => process.stderr.write(text),
};

// Last line of defence: an unexpected error prints a redacted one-liner, never a
// stack trace with private paths, hosts, or ARNs.
runCli(process.argv.slice(2), process.env, streams, PRODUCTION_DEPENDENCIES).then(
  (status) => {
    process.exitCode = status;
  },
  (error: unknown) => {
    streams.stderr(`audit transport comparison: unexpected error: ${describeError(error)}\n`);
    process.exitCode = EXIT_CODES.unexpectedError;
  },
);
