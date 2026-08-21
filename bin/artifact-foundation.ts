#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';

import { ArtifactFoundationStack } from '../lib/artifact-foundation-stack';

const app = new cdk.App();

new ArtifactFoundationStack(app, 'ArtifactFoundationStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
