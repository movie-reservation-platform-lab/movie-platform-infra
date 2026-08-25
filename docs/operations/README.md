# Infrastructure Operations

This folder owns runbooks and operational notes for the standalone platform
infrastructure repository.

## Runbooks

- [AWS Artifact Foundation Runbook](./aws-artifact-foundation.md): controlling
  path for the persistent ECR foundation, its deployment, verification,
  admission handoff, recovery, and guarded final cleanup.
- [Standalone-Account Identity Center And Grafana Access Bootstrap](./standalone-account-access-bootstrap.md):
  persistent Organization/Identity Center prerequisites, MFA-backed operator
  access, and the temporary-Admin-to-Editor Grafana workflow.
- [AWS CDK Deployment Runbook](./aws-cdk-deployment.md)
- [Temporary Integrated AWS Demo Runbook](./temporary-integrated-demo.md):
  controlling deadline path for six exact images, the seven-container task,
  unified Grafana correlation, three-scenario smoke, and routine teardown.
- [AWS Demo Release Checklist](./aws-demo-release-checklist.md): the offline
  repository gate followed by the separately approved live rehearsal.

## Operational Rules

- Do not deploy, destroy, or mutate AWS resources without explicit operator
  intent.
- Require `npm run preflight:aws` before each short group of AWS mutations, and
  verify the selected application image digest and ingress prefix list before
  deploy or destroy.
- Keep public CI credential-free. CI synths should use fake context and
  `--no-lookups`.
- Treat prefix-list entry changes as access-control changes even though they do
  not require a stack redeploy.
- Destroy disposable demo stacks promptly after testing to control cost.
- Preserve `ArtifactFoundationStack` during routine workload teardown. Use its
  separately guarded cleanup only for explicit final project cleanup.

## Smoke Checks

The repository owns deterministic smoke tooling for deployed observability:

- `npm run smoke:xray`
- `npm run smoke:managed-metrics`
- `npm run smoke:integrated-demo`

Run these only after a real deploy, with an explicit AWS profile and Region.
