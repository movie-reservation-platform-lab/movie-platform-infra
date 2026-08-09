# Movie Platform Infra

Standalone AWS CDK infrastructure for the Movie Reservation Platform Lab AWS
demo.

This repository owns platform infrastructure only. Application repositories
build, test, and publish immutable artifacts; this CDK app consumes application
images by private ECR digest and does not build sibling repository source during
synth or deployment.

## Current Stack

The current stack is `GoldenPathDemoStack`. It models the first AWS demo
reservation workload:

- public Application Load Balancer;
- two-AZ VPC with public and isolated subnet groups;
- private isolated Fargate task pinned to one workload Availability Zone;
- no NAT Gateway;
- ECS cluster named `movie-reservation-platform-aws-demo`;
- imported digest-pinned reservation service image from private ECR;
- repository-owned ADOT collector Docker image asset;
- one-week CloudWatch log groups for app logs, collector logs, application
  metrics, and enhanced Container Insights performance events;
- ADOT sidecar exporting traces to X-Ray and application/ECS metrics to
  CloudWatch and AMP;
- disposable AMP workspace and prefix-list-restricted Amazon Managed Grafana
  workspace;
- VPC endpoints for ECR image pull, CloudWatch Logs, X-Ray, AMP remote write,
  and STS.

The stack still runs the reservation service with
`COMPOSITION_PROFILE=local-fixed-user` for the disposable demo. Database,
multi-service topology, frontend hosting, MCP services, promotion automation,
and environment manifests are separate follow-up slices.

## Useful Commands

Run commands from this repository root:

```bash
npm ci
npm run build
npm test
npm run validate:adot-image
npm run validate:xray-smoke
npm run validate:managed-metrics-smoke
npm run validate:grafana-dashboard
npm run synth:ecr-contract
npm run ci
```

`npm run synth:ecr-contract` uses a fake account, fake repository, and all-zero
digest with `--no-lookups`. It proves the CDK app accepts an immutable image
contract offline; it does not prove the image exists in AWS.

## Application Image Contract

Standalone synth/deploy requires both application image inputs:

```bash
npm run cdk -- synth \
  -c allowedIngressPrefixListId=pl-0123456789abcdef0 \
  -c applicationImageReference=111111111111.dkr.ecr.eu-central-1.amazonaws.com/movie-reservation-service@sha256:<64-hex-digest> \
  -c applicationServiceVersion=<release-id>
```

The image reference must be a private ECR URI pinned by `sha256` digest. Mutable
tags such as `latest` or `1.2.3` are rejected. In ECR image mode,
`CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` must match the registry account
and Region encoded in the image URI.

## Ingress Prefix List

The public ALB and Amazon Managed Grafana workspace both use the same
customer-managed IPv4 prefix list. Create and maintain that prefix list manually
in the target account and Region, then pass its ID with
`-c allowedIngressPrefixListId=<prefix-list-id>`.

Example creation for one trusted `/32`:

```bash
aws ec2 create-managed-prefix-list \
  --prefix-list-name movie-reservation-platform-aws-demo-ingress \
  --address-family IPv4 \
  --max-entries 10 \
  --entries Cidr=<your-public-ip>/32,Description=developer-laptop
```

To add another trusted `/32`, read the current version and modify the list:

```bash
aws ec2 describe-managed-prefix-lists \
  --filters Name=prefix-list-name,Values=movie-reservation-platform-aws-demo-ingress \
  --query 'PrefixLists[0].{PrefixListId:PrefixListId,Version:Version}'

aws ec2 modify-managed-prefix-list \
  --prefix-list-id <prefix-list-id> \
  --current-version <version> \
  --add-entries Cidr=<new-public-ip>/32,Description=<operator-or-location>
```

Updating prefix list entries changes who can reach the ALB and Grafana without
redeploying the CDK stack. Keep the list scoped to trusted `/32` entries; do
not add `0.0.0.0/0`.

## CDK Workflow

CDK has three separate steps:

- `synth` runs the TypeScript app and writes a CloudFormation template to
  `cdk.out`.
- `bootstrap` prepares one AWS account and Region for CDK deployments by
  creating CDK toolkit resources, including asset storage.
- `deploy` publishes assets, creates a CloudFormation change set, and applies it
  to the selected AWS account and Region.

Use this order for a real deployment:

```bash
aws sts get-caller-identity

npm run cdk -- bootstrap aws://<account-id>/<region> \
  -c allowedIngressPrefixListId=<prefix-list-id> \
  -c applicationImageReference=<account-id>.dkr.ecr.<region>.amazonaws.com/movie-reservation-service@sha256:<64-hex-digest> \
  -c applicationServiceVersion=<release-id>

npm run cdk -- synth \
  -c allowedIngressPrefixListId=<prefix-list-id> \
  -c applicationImageReference=<account-id>.dkr.ecr.<region>.amazonaws.com/movie-reservation-service@sha256:<64-hex-digest> \
  -c applicationServiceVersion=<release-id>

npm run cdk -- diff \
  -c allowedIngressPrefixListId=<prefix-list-id> \
  -c applicationImageReference=<account-id>.dkr.ecr.<region>.amazonaws.com/movie-reservation-service@sha256:<64-hex-digest> \
  -c applicationServiceVersion=<release-id>

npm run cdk -- deploy GoldenPathDemoStack \
  -c allowedIngressPrefixListId=<prefix-list-id> \
  -c applicationImageReference=<account-id>.dkr.ecr.<region>.amazonaws.com/movie-reservation-service@sha256:<64-hex-digest> \
  -c applicationServiceVersion=<release-id>
```

Do not run `deploy` until the account, Region, stack name, ingress prefix list,
selected application digest, and expected cost are clear. This stack creates a
public ALB, ECS/Fargate service, an ADOT Docker image asset, CloudWatch log
groups, custom and enhanced Container Insights metrics, AMP and Managed Grafana
workspaces, a Grafana data-access role, and interface VPC endpoints.

For a real deploy, replace `pl-0123456789abcdef0` with your customer-managed
IPv4 prefix list ID. The configuration boundary validates the ID shape offline.
Follow the authenticated
[prefix-list preflight](docs/operations/aws-cdk-deployment.md#prefix-list-preflight)
to verify the external list's ownership, Region, IPv4 family, capacity, and
entries before deployment.

## Smoke Tooling

After deployment, run the deterministic trace smoke with the same AWS profile
and Region:

```bash
AWS_PROFILE=<profile> AWS_REGION=<region> \
  npm run smoke:xray -- --report /tmp/xray-smoke.json
```

Install `awscurl` once on the laptop, then run the managed-metrics smoke:

```bash
AWS_PROFILE=<profile> AWS_REGION=<region> \
  npm run smoke:managed-metrics -- --report /tmp/managed-metrics-smoke.json
```

## Teardown

Destroy the stack with the same required context boundary:

```bash
npm run cdk -- destroy GoldenPathDemoStack \
  -c allowedIngressPrefixListId=<prefix-list-id> \
  -c applicationImageReference=<account-id>.dkr.ecr.<region>.amazonaws.com/movie-reservation-service@sha256:<64-hex-digest> \
  -c applicationServiceVersion=<release-id>
```

Confirm that the CloudFormation stack, ALB, ECS service/tasks, AMP and Grafana
workspaces, Grafana role, VPC endpoints, and log groups are gone. The
customer-managed prefix list, CDK bootstrap, Organizations, and IAM Identity
Center resources are account/Region-level and are not part of
`GoldenPathDemoStack`.

## Optional Context

```bash
npm run cdk -- synth \
  -c allowedIngressPrefixListId=pl-0123456789abcdef0 \
  -c applicationImageReference=<account-id>.dkr.ecr.<region>.amazonaws.com/movie-reservation-service@sha256:<64-hex-digest> \
  -c applicationServiceVersion=<release-id> \
  -c enableEcsExec=true
```

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
