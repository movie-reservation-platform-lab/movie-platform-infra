# ECS Infra

AWS CDK app for the golden-path ECS demo environment.

For one-time AWS account access and bootstrap setup plus the complete local
synth, deploy, verification, teardown, and cost-control procedure, see the
[local AWS CDK deployment runbook](../docs/operations/aws-cdk-local-deployment.md).

The current stack is `GoldenPathDemoStack`. It models the first backend-only ECS
slice:

- public Application Load Balancer;
- VPC public and isolated subnet groups spanning two Availability Zones;
- private isolated Fargate task and interface endpoints pinned to one workload
  Availability Zone;
- no NAT Gateway;
- platform-scoped ECS application cluster named
  `movie-reservation-platform-aws-demo`;
- CDK Docker image assets for `movie-reservation-service` and the repository-owned
  ADOT collector;
- separate one-week CloudWatch log groups for the app, collector, and EMF
  application metrics;
- nonessential ADOT sidecar receiving OTLP/HTTP on task loopback and exporting
  traces to X-Ray plus the ten existing application metrics to CloudWatch;
- VPC endpoints for ECR image pull, CloudWatch log delivery, and X-Ray writes.

The stack runs the app with `COMPOSITION_PROFILE=local-fixed-user` and in-memory
persistence. The AWS demo enables the fake in-process worker and deterministic
failure injection so smoke traffic creates useful metric outcomes. Issue #37's
trace path and issue #38 PR 1's CloudWatch application-metric path are included.
Later issue #38 PRs own AMP, ECS metrics, enhanced Container Insights, and
Amazon Managed Grafana. Database work is separate: issue #7 owns RDS and a
deployment-time ECS migration `RunTask`. A Postgres sidecar is not planned for
this stack.

## Useful commands

Run commands from the repository root:

```bash
npm -w ecs-infra run build
npm -w ecs-infra test
npm -w ecs-infra run validate:adot-image
npm -w ecs-infra run validate:xray-smoke
npm -w ecs-infra run validate:managed-metrics-smoke
npm -w ecs-infra run cdk -- synth -c allowedIngressCidr=203.0.113.10/32
```

The collector Dockerfile pins the official Public ECR ADOT `v0.48.0` image at
multi-architecture digest
`sha256:9b28046359054b414f4ba76056ba4e8cffda2d53fbcee06171d7eeecd71326c3`,
verified on 2026-07-18. That release does not expose a standalone config
validation subcommand, so `validate:adot-image` proves the exact baked config by
starting the pinned collector and reaching its bundled `/healthcheck` binary.
Successful startup also proves the referenced OTLP receiver, memory limiter,
attributes and batch processors, X-Ray/EMF exporters, and health extension are
present.

For a real deploy, replace `203.0.113.10/32` with your current public IP CIDR.
That context value controls which source IP range can reach the public ALB on
HTTP port 80. The configuration boundary rejects `0.0.0.0/0`; the current demo
must not expose the listener to the entire internet.

The VPC topology and workload placement are intentionally not CDK context
options. The VPC spans two Availability Zones because an internet-facing ALB
requires that shape. The single Fargate task and each interface endpoint use
one selected workload subnet to keep the disposable demo cheaper. Cross-zone
load balancing is explicitly enabled so both ALB nodes can route to that target.
A production-shaped deployment should place workloads and endpoints in at
least two Availability Zones.

## CDK workflow

CDK has three separate steps that are easy to blur together:

- `synth` runs the TypeScript app and writes a CloudFormation template to
  `ecs-infra/cdk.out`.
- `bootstrap` prepares one AWS account and region for CDK deployments by
  creating the CDK toolkit resources, including asset storage.
- `deploy` publishes assets, creates a CloudFormation change set, and applies it
  to the selected AWS account and region.

Use this order for the first real deployment:

```bash
aws sts get-caller-identity

npm -w ecs-infra run cdk -- bootstrap aws://<account-id>/<region> \
  -c allowedIngressCidr=<your-public-ip>/32

npm -w ecs-infra run cdk -- synth \
  -c allowedIngressCidr=<your-public-ip>/32

npm -w ecs-infra run cdk -- diff \
  -c allowedIngressCidr=<your-public-ip>/32

npm -w ecs-infra run cdk -- deploy GoldenPathDemoStack \
  -c allowedIngressCidr=<your-public-ip>/32
```

Do not run `deploy` until the account, region, stack name, public ingress CIDR,
and expected cost are clear. This stack creates a public ALB, ECS/Fargate
service, two ECR image assets, three CloudWatch log groups, custom CloudWatch
metrics, and VPC endpoints.

After deployment, run the deterministic trace smoke with the same explicit
profile and Region:

```bash
AWS_PROFILE=<profile> AWS_REGION=<region> \
  npm -w ecs-infra run smoke:xray -- --report /tmp/xray-smoke.json
```

The report includes the generated W3C `traceparent` and converted X-Ray trace
ID so the exact request can be inspected without broad time-window searches.

Run the CloudWatch application-metrics smoke separately:

```bash
AWS_PROFILE=<profile> AWS_REGION=<region> \
  npm -w ecs-infra run smoke:managed-metrics -- \
  --report /tmp/managed-metrics-smoke.json
```

It generates bounded reservation traffic, requires both confirmed and
failed/rejected outcomes, then queries `graphql_operation_total` in the
stack-output namespace.

After testing, destroy the stack with the same required context boundary:

```bash
npm -w ecs-infra run cdk -- destroy GoldenPathDemoStack \
  -c allowedIngressCidr=<your-public-ip>/32
```

Confirm that the CloudFormation stack, ALB, ECS service/tasks, VPC endpoints,
and all three log groups are gone. Ingested X-Ray traces and historical
CloudWatch metric datapoints follow their service retention; stack destruction
stops new publication but does not delete that history immediately. CDK
bootstrap resources are account/region-level and
are not part of `GoldenPathDemoStack`; their S3 bucket and ECR repository remain
for future CDK deployments and should be reviewed separately if the account is
being fully cleaned up.

## Reference docs

- AWS CDK Developer Guide: https://docs.aws.amazon.com/cdk/v2/guide/home.html
- AWS CDK API Reference: https://docs.aws.amazon.com/cdk/api/v2/
- AWS CDK best practices: https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html
- AWS CDK bootstrapping: https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html
- AWS CDK testing: https://docs.aws.amazon.com/cdk/v2/guide/testing.html
- ECS construct library: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs-readme.html
- ECS patterns library: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs_patterns-readme.html

Optional context:

```bash
npm -w ecs-infra run cdk -- synth \
  -c allowedIngressCidr=203.0.113.10/32 \
  -c enableEcsExec=true
```

`enableEcsExec=true` enables ECS Exec on the service, adds the private
`ssmmessages` endpoint, and grants the ECS task role permission to open the SSM
message channels used by Exec. It is off by default to avoid the additional
endpoint cost.

The human or automation invoking `aws ecs execute-command` also needs separate
operator-side IAM permission such as `ecs:ExecuteCommand`. This stack does not
grant permissions to your AWS identity.

Application metric export defaults to 30 seconds. Use
`-c metricsExportIntervalSeconds=<5-300>` consistently across CDK commands to
test another cadence.

Before the next #38 PR expands the endpoint set for AMP and STS, compare the
region-specific hourly cost of the full endpoint inventory with a NAT-based
alternative. The current no-NAT decision is a deliberate checkpoint, not a
rule that every future AWS service must receive another endpoint automatically.
