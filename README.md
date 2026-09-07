# Movie Platform Infra

Standalone AWS CDK infrastructure for the Movie Reservation Platform Lab AWS
demo.

This repository owns platform infrastructure only. Application repositories
build, test, and publish immutable artifacts; this CDK app consumes application
images by private ECR digest and does not build sibling repository source during
synth or deployment.

## Current Stacks

The current CDK apps have separate lifecycle boundaries:

- `ArtifactFoundationStack` owns the six persistent, account-local ECR
  repositories used for admitted application image artifacts. Routine demo
  teardown must preserve this stack and its retained repositories. Cleanup
  inspection reads an explicit artifact destination catalog; it does not
  discover sibling repositories from the workspace.
- `MovieReservationWorkloadStack` owns the disposable AWS demo reservation workload.
- `ObservabilityStack` owns AMP, optional Grafana and operational log groups.
- `AuditStack` owns Firehose, the S3 audit/ALB archives, CloudTrail and Athena.

Start with the [audit demo deploy/destroy runbook](docs/operations/audit-demo.md)
and [architecture](docs/architecture/audit-and-observability.md). Both foundations
must exist before workload deployment. Their resources are not deleted by a
workload-only teardown.

`MovieReservationWorkloadStack` models:

- public Application Load Balancer;
- two-AZ VPC with public and isolated subnet groups;
- private isolated Fargate task pinned to one workload Availability Zone;
- no NAT Gateway;
- ECS cluster named `movie-reservation-platform-aws-demo`;
- six independently published, digest-pinned application images from private
  ECR in one temporary eight-container task;
- repository-owned ADOT collector and FireLens/Fluent Bit router image assets;
- imported operational log groups owned by the observability stack;
- ADOT sidecar exporting traces to X-Ray and application/ECS metrics to
  CloudWatch and AMP;
- imported AMP and Grafana discovery outputs;
- VPC endpoints for ECR image pull, CloudWatch Logs, X-Ray, AMP remote write,
  STS, Firehose and (when demo login is enabled) Secrets Manager;
- native ALB access logs in the audit-owned bucket.

The integrated task runs the Nginx frontend, deterministic reservation agent,
two MCP servers, two APIs, ADOT and the audit router. Only web port 8088
is registered with the ALB. This is a deadline demo shortcut, not the later
independently deployable topology.

## Useful Commands

Run commands from this repository root:

```bash
npm ci
npm run validate:aws-account-preflight
npm run validate:artifact-foundation-cleanup
npm run validate:artifact-copy
npm run build:artifact-copy-cli
npm run copy:artifact -- --help
npm run build
npm run test:cdk
npm run test:tooling
npm run validate:adot-image
npm run validate:audit-router
npm run validate:xray-smoke
npm run validate:managed-metrics-smoke
npm run validate:integrated-demo-smoke
npm run validate:grafana-dashboard
npm run synth:ecr-contract
npm run synth:artifact-foundation
npm run synth:audit
npm run synth:observability
npm run ci
```

`npm test` remains the convenience command for all CDK and repository-tooling
Jest tests under `test/`. The account-preflight, artifact-foundation cleanup,
and artifact-copy automation packages have their own TypeScript and Jest
configurations, so CI validates them separately and before CDK or tooling tests.

`npm run validate:artifact-copy` is credential-free and performs no registry
mutation. It validates strict single-manifest copy and existing-content
verification mechanics, the no-shell Skopeo adapter contract, and the sanitized
CLI boundary. The live invocation accepts a strict versioned request file and a
separate trusted `--skopeo-executable` argument through
`npm run copy:artifact`; candidate policy, operation selection, binary pinning,
trusted destination selection, credentials, and orchestration remain private
environment-repository work. See
[`automation/artifact-copy/README.md`](automation/artifact-copy/README.md) for
the request schema, credential-free compiled-runtime handoff, and stable exit
classifications.

`npm run synth:ecr-contract` uses a fake account, fake repository, and all-zero
digest with `--no-lookups`. It proves the CDK app accepts an immutable image
contract offline; it does not prove the image exists in AWS.

`npm run validate:artifact-foundation-cleanup` is credential-free. The live
read-only cleanup-readiness check is separate:

```bash
npm run cleanup:artifact-foundation
```

Follow the controlling
[artifact-foundation runbook](docs/operations/aws-artifact-foundation.md) before
deploying, verifying, or finally deleting the persistent foundation.

## AWS Operator Access

Before a real AWS deployment, complete the
[standalone-account access bootstrap](docs/operations/standalone-account-access-bootstrap.md).
It creates the dedicated MFA-backed `movie-platform-demo` Identity Center
profile and the private target file used by the read-only safety gate.

```bash
export AWS_PROFILE=movie-platform-demo
export AWS_REGION=eu-central-1

aws sso login --profile "$AWS_PROFILE"
npm run preflight:aws
```

The preflight must pass before each short group of AWS mutations. Keep real
account and role values in the operator-owned JSON target outside Git. Follow
the [artifact-foundation runbook](docs/operations/aws-artifact-foundation.md)
for the persistent ECR boundary, the detailed
[workload deployment runbook](docs/operations/aws-cdk-deployment.md) for the
disposable demo, and the
[two-gate release checklist](docs/operations/aws-demo-release-checklist.md) for
an approved rehearsal.

## Artifact Foundation Workflow

The foundation has its own CDK entrypoint and does not require workload context:

```bash
npm run cdk:foundation -- synth ArtifactFoundationStack --no-lookups
npm run preflight:aws
npm run cdk:foundation -- diff ArtifactFoundationStack

npm run preflight:aws
npm run cdk:foundation -- deploy ArtifactFoundationStack
```

The deploy command creates the persistent, termination-protected ECR
destinations. The private `movie-platform-environments` repository selects the
approved immutable GHCR candidates and hands their exact ECR digests to the
workload deployment. This repository does not build sibling application source.

Routine demo teardown must not run a foundation destroy command. Final project
cleanup uses the separate guarded workflow described in the
[artifact-foundation runbook](docs/operations/aws-artifact-foundation.md#guarded-final-cleanup).

## GitHub OIDC Trust Workflow

The GitHub trust roles have their own CDK entrypoint so changing private
workflow identities does not couple their lifecycle to the persistent artifact
repository or the disposable workload stack. The public repository contains
only fake test bindings:

```bash
npm run synth:github-oidc-trust
```

Real synthesis requires a private JSON file supplied at runtime:

```bash
npm run cdk -- \
  --app "npx ts-node --prefer-ts-exts bin/github-oidc-trust.ts" \
  synth GitHubOidcTrustStack \
  --no-lookups \
  -c githubOidcTrustConfigFile=/private/path/github-oidc-trust.json
```

The version-1 file provides the CDK bootstrap qualifier and separate exact
GitHub `subject`, repository name and immutable IDs, workflow name, `main` ref,
and GitHub Environment for admission and deployment. Both roles must belong to
the same repository and owner identities, while their workflows and GitHub
Environments must remain separate. The exact `subject` is copied as an opaque
claim so private configuration can use GitHub's supported subject formats.
Wildcards, placeholders, and non-main refs are rejected. Do not commit a real
file, account ID, repository name, or workflow identity here.

The admission role can authenticate to ECR and write/read only the
infra-owned reservation-service repository. The deployment entry role has no
admission permission; it can assume only the selected account and Region's
exact modern CDK bootstrap roles. The bootstrap `CloudFormationExecutionRole`
still determines effective deployment authority and requires a separate live
policy review before use.

This repository currently validates and synthesizes the trust mechanics only.
Do not deploy or assume these roles without an explicit reviewed private
binding and user authorization.

## Application Image Contract

Standalone synth/deploy maps each environment release component's
`destinationImageReference` and `deploymentVersion` to a private-ECR image
reference and service-version context pair:

| Component | Image context | Version context |
| --- | --- | --- |
| Reservation service | `applicationImageReference` | `applicationServiceVersion` |
| Reservation web | `reservationWebImageReference` | `reservationWebServiceVersion` |
| Reservation agent | `reservationAgentImageReference` | `reservationAgentServiceVersion` |
| Reservation MCP | `reservationMcpImageReference` | `reservationMcpServiceVersion` |
| Recommendation MCP | `recommendationMcpImageReference` | `recommendationMcpServiceVersion` |
| Recommendation service | `recommendationServiceImageReference` | `recommendationServiceVersion` |

Every image reference must use its expected repository and be pinned by a
`sha256` digest. Mutable tags are rejected. All six references must encode the
same concrete account and Region supplied through `CDK_DEFAULT_ACCOUNT` and
`CDK_DEFAULT_REGION`. The environment release's `sourceVersion` remains
provenance and must not replace `deploymentVersion` at this boundary.

## Ingress Prefix List

The public ALB and Amazon Managed Grafana workspace both use the same
customer-managed IPv4 prefix list. Create and maintain that prefix list manually
in the target account and Region, then pass its ID with
`-c allowedIngressPrefixListId=<prefix-list-id>`.

Example creation for one trusted `/32`:

```bash
npm run preflight:aws

aws ec2 create-managed-prefix-list \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --prefix-list-name movie-reservation-platform-aws-demo-ingress \
  --address-family IPv4 \
  --max-entries 10 \
  --entries 'Cidr=<your-public-ip>/32,Description=developer-laptop'
```

To add another trusted `/32`, read the current version and modify the list:

```bash
npm run preflight:aws

aws ec2 describe-managed-prefix-lists \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --filters Name=prefix-list-name,Values=movie-reservation-platform-aws-demo-ingress \
  --query 'PrefixLists[0].{PrefixListId:PrefixListId,Version:Version}'

aws ec2 modify-managed-prefix-list \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --prefix-list-id "$ALLOWED_INGRESS_PREFIX_LIST_ID" \
  --current-version '<version>' \
  --add-entries 'Cidr=<new-public-ip>/32,Description=<operator-or-location>'
```

Updating prefix list entries changes who can reach the ALB and Grafana without
redeploying the CDK stack. Keep the list scoped to trusted `/32` entries; do
not add `0.0.0.0/0`.

## Workload CDK Workflow

Use the
[temporary integrated demo runbook](docs/operations/temporary-integrated-demo.md)
as the controlling sequence for the six-image release. It supplies the complete
context array and separate approval gates for foundation expansion, exact
artifact copying, CDK diff, workload deployment, Grafana setup, smoke, and
teardown.

Do not run `deploy` until the account, Region, stack name, ingress prefix list,
all six application digests, expected cost, and teardown owner are clear. The
stack creates a public ALB, ECS/Fargate service, an ADOT Docker image asset,
CloudWatch log groups, custom and enhanced Container Insights metrics, AMP and
Managed Grafana workspaces, a Grafana data-access role, and interface VPC
endpoints.

For a real deploy, replace `pl-0123456789abcdef0` with your customer-managed
IPv4 prefix list ID. The configuration boundary validates the ID shape offline.
Follow the authenticated
[prefix-list preflight](docs/operations/aws-cdk-deployment.md#prefix-list-preflight)
to verify the external list's ownership, Region, IPv4 family, capacity, and
entries before deployment.

## Smoke Tooling

After deployment, run the three application scenarios through the public web
route before the telemetry-specific checks:

```bash
npm run smoke:integrated-demo -- \
  --base-url "$DEMO_BASE_URL" \
  --report .local/integrated-demo-smoke.json
```

Then run the deterministic trace smoke with the same AWS profile and Region:

```bash
AWS_PROFILE="$AWS_PROFILE" AWS_REGION="$AWS_REGION" \
  npm run smoke:xray -- --report /tmp/xray-smoke.json
```

Install `awscurl` once on the laptop, then run the managed-metrics smoke:

```bash
AWS_PROFILE="$AWS_PROFILE" AWS_REGION="$AWS_REGION" \
  npm run smoke:managed-metrics -- --report /tmp/managed-metrics-smoke.json
```

## Teardown

Use Gate 6 of the
[temporary integrated demo runbook](docs/operations/temporary-integrated-demo.md#gate-6-teardown)
with the same complete six-image context and a fresh explicit approval.

Confirm that the CloudFormation stack, ALB, ECS service/tasks, AMP and Grafana
workspaces, Grafana role, VPC endpoints, and log groups are gone. The
customer-managed prefix list, CDK bootstrap, Organizations, and IAM Identity
Center resources are account/Region-level and are not part of
`MovieReservationWorkloadStack`. Follow the bootstrap runbook's first-rehearsal exit gate
to replace and remove the temporary `AdministratorAccess` assignment before a
second workload deployment.

This is routine demo teardown. It intentionally preserves
`ArtifactFoundationStack` and the retained ECR repositories. For final project
cleanup, follow the separate controlling runbook and inspect readiness first:

```bash
npm run cleanup:artifact-foundation
```

## Optional Context

Append `-c enableEcsExec=true` to every synth, diff, deploy, and destroy command
that uses the runbook's complete `CDK_CONTEXT` array.

`enableEcsExec=true` enables ECS Exec on the service, adds the private
`ssmmessages` endpoint, and grants the ECS task role permission to open the SSM
message channels used by Exec. It is off by default to avoid the additional
endpoint cost.

Application metric export defaults to 30 seconds. Use
`-c metricsExportIntervalSeconds=<5-300>` consistently across CDK commands to
test another cadence.

## Reference Docs

- AWS CDK Developer Guide: https://docs.aws.amazon.com/cdk/v2/guide/home.html
- AWS CDK API Reference: https://docs.aws.amazon.com/cdk/api/v2/
- AWS CDK best practices: https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html
- AWS CDK bootstrapping: https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html
- AWS CDK testing: https://docs.aws.amazon.com/cdk/v2/guide/testing.html
- ECS Developer Guide: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/Welcome.html
