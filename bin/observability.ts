#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ObservabilityStack } from '../lib/observability-stack';
import { resolveObservabilityConfig } from '../lib/config/foundation-config';

const app = new cdk.App();
new ObservabilityStack(app, 'ObservabilityStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  config: resolveObservabilityConfig({
    allowedIngressPrefixListId: app.node.tryGetContext('allowedIngressPrefixListId'),
    enableGrafana: app.node.tryGetContext('enableGrafana'),
  }),
});
