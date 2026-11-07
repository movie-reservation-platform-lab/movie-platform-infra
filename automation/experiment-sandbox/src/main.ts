#!/usr/bin/env node
/**
 * Entry point of `npm run sandbox:experiment`. Runs the CLI and turns its result into the
 * process exit code: 0 done, 2 the operator must act, 1 the command failed.
 */

import { runCli } from './cli';

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(
      `Sandbox operation blocked: ${error instanceof Error ? error.message : 'unexpected failure'}`,
    );

    process.exitCode = 1;
  });
