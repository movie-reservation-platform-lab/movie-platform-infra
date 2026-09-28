#!/usr/bin/env node

import { runOperatorCli } from './operator-cli';

process.exitCode = runOperatorCli(process.argv.slice(2));
