# Infrastructure Operations

This folder owns runbooks and operational notes for the standalone platform
infrastructure repository.

## Runbooks

- [Standalone-Account Identity Center And Grafana Access Bootstrap](./standalone-account-access-bootstrap.md):
  persistent Organization/Identity Center prerequisites, MFA-backed operator
  access, and the temporary-Admin-to-Editor Grafana workflow.
- [AWS CDK Deployment Runbook](./aws-cdk-deployment.md)

## Operational Rules

- Do not deploy, destroy, or mutate AWS resources without explicit operator
  intent.
- Always verify the AWS account, Region, selected application image digest, and
  ingress prefix list before deploy or destroy.
- Keep public CI credential-free. CI synths should use fake context and
  `--no-lookups`.
- Treat prefix-list entry changes as access-control changes even though they do
  not require a stack redeploy.
- Destroy disposable demo stacks promptly after testing to control cost.

## Smoke Checks

The repository owns deterministic smoke tooling for deployed observability:

- `npm run smoke:xray`
- `npm run smoke:managed-metrics`

Run these only after a real deploy, with an explicit AWS profile and Region.
