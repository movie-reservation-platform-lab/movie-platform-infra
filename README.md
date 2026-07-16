# ECS Infra

AWS CDK app for the golden-path ECS demo environment.

The current stack is `GoldenPathDemoStack`. It models the first backend-only ECS
slice:

- public Application Load Balancer;
- VPC public and isolated subnet groups spanning two Availability Zones;
- private isolated Fargate task and interface endpoints pinned to one workload
  Availability Zone;
- no NAT Gateway;
- platform-scoped ECS application cluster named
  `movie-reservation-platform-aws-demo`;
- CDK Docker image asset for `movie-reservation-service`;
- CloudWatch log group for the app container;
- VPC endpoints for ECR image pull and CloudWatch log delivery.

Wave 2 intentionally runs the app with `COMPOSITION_PROFILE=local-fixed-user`
and in-memory persistence. The Postgres sidecar, migration container, ADOT
collector, and production-shaped observability path are later waves.

## Useful commands

Run commands from the repository root:

```bash
npm -w ecs-infra run build
npm -w ecs-infra test
npm -w ecs-infra run cdk -- synth -c allowedIngressCidr=203.0.113.10/32
```

For a real deploy, replace `203.0.113.10/32` with your current public IP CIDR.
That context value controls which source IP range can reach the public ALB on
HTTP port 80. The configuration boundary rejects `0.0.0.0/0`; the Wave 2 demo
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

npm -w ecs-infra run cdk -- bootstrap aws://<account-id>/<region>

npm -w ecs-infra run cdk -- synth \
  -c allowedIngressCidr=<your-public-ip>/32

npm -w ecs-infra run cdk -- diff \
  -c allowedIngressCidr=<your-public-ip>/32

npm -w ecs-infra run cdk -- deploy GoldenPathDemoStack \
  -c allowedIngressCidr=<your-public-ip>/32
```

Do not run `deploy` until the account, region, stack name, public ingress CIDR,
and expected cost are clear. This stack creates a public ALB, ECS/Fargate
service, ECR image asset, CloudWatch log group, and VPC endpoints.

After testing, destroy the stack with the same required context boundary:

```bash
npm -w ecs-infra run cdk -- destroy GoldenPathDemoStack \
  -c allowedIngressCidr=<your-public-ip>/32
```

Confirm that the CloudFormation stack, ALB, ECS service/tasks, VPC endpoints,
and log group are gone. CDK bootstrap resources are account/region-level and
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

Before Wave 4 adds X-Ray, AMP, or STS endpoints, compare the region-specific
hourly cost of the expanded endpoint set with a NAT-based alternative. The
current no-NAT decision is a deliberate checkpoint, not a rule that every
future AWS service must receive another endpoint automatically.
