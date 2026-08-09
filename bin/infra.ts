#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GoldenPathDemoStack } from '../lib/infra-stack';
import { resolvePlatformConfig } from '../lib/config/platform-config';

const app = new cdk.App();

const deploymentTarget = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const platformConfig = resolvePlatformConfig(
  {
    allowedIngressCidr: app.node.tryGetContext('allowedIngressCidr'),
    applicationImageReference: app.node.tryGetContext('applicationImageReference'),
    applicationServiceVersion: app.node.tryGetContext('applicationServiceVersion'),
    enableEcsExec: app.node.tryGetContext('enableEcsExec'),
    metricsExportIntervalSeconds: app.node.tryGetContext('metricsExportIntervalSeconds'),
  },
  deploymentTarget,
);

new GoldenPathDemoStack(app, 'GoldenPathDemoStack', {
  env: deploymentTarget,
  platformConfig,
});
