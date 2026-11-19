#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { cli, safeError } from './cli';

void cli(process.argv.slice(2), {
  env: process.env,
  readJson: async (path) => JSON.parse(await readFile(path, 'utf8')),
  write: (value) => process.stdout.write(value + '\n'),
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(safeError(error) + '\n');
    process.exitCode = 1;
  });
