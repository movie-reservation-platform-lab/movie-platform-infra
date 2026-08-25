#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';

import { loadGitHubOidcTrustConfig } from '../lib/config/github-oidc-trust-config';
import { GitHubOidcTrustStack } from '../lib/github-oidc-trust-stack';

const app = new cdk.App();
const trustConfig = loadGitHubOidcTrustConfig(
  app.node.tryGetContext('githubOidcTrustConfigFile'),
);

new GitHubOidcTrustStack(app, 'GitHubOidcTrustStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  trustConfig,
});

