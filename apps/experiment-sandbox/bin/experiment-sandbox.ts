#!/usr/bin/env node
import * as fs from 'node:fs';

import { App } from 'aws-cdk-lib';

import { parseSandboxConfig, sandboxResourceNames } from '../lib/config';
import { ExperimentControlStack } from '../lib/control-stack';
import { ExperimentWorkloadStack } from '../lib/workload-stack';

const app = new App();

// The operator passes the config file explicitly. There are no environment
// defaults or account lookups, so synth only ever targets the named sandbox.
const configPath: unknown = app.node.tryGetContext('sandboxConfig');

if (typeof configPath !== 'string' || !configPath) {
  throw new Error(
    'Explicit -c sandboxConfig=<operator-owned JSON path> required; no environment defaults or lookups',
  );
}

const config = parseSandboxConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
const names = sandboxResourceNames(config);
const env = { account: config.accountId, region: config.region };

const control = new ExperimentControlStack(app, names.controlStack, config, {
  env,
  stackName: names.controlStack,
});

new ExperimentWorkloadStack(app, names.workloadStack, config, control, {
  env,
  stackName: names.workloadStack,
});
