---
name: aws-cdk-iac
description: Use when designing, implementing, reviewing, or explaining AWS CDK infrastructure in this standalone repo, including construct choices, CloudFormation output, networking, IAM, ECS/Fargate, asset publishing, tests, synth/deploy workflow, and CDK best practices.
---

# AWS CDK IaC

Use this skill for AWS CDK work in this standalone infrastructure repository.

Pair it with:

- `.ai/rules/teaching-mode.md` when explaining CDK concepts.
- `.ai/skills/principal-engineer-planner/SKILL.md` before non-trivial infrastructure changes.
- `.ai/skills/typescript/SKILL.md` when changing TypeScript types, stack props, config boundaries, or tests.

## Repository Context

This repository uses a standalone npm package CDK app:

```text
bin/infra.ts
lib/
test/
adot-collector/
grafana/dashboards/
cdk.json
package.json
```

Run CDK commands from the repository root through npm scripts:

```bash
npm run build
npm test
npm run cdk -- synth -c allowedIngressCidr=203.0.113.10/32 -c applicationImageReference=<account>.dkr.ecr.<region>.amazonaws.com/movie-reservation-service@sha256:<digest> -c applicationServiceVersion=<release-id>
```

Do not assume a global `cdk` binary.

## Core Mental Model

Teach and reason through the three layers explicitly:

- CDK code: TypeScript constructs and props.
- Synthesized CloudFormation: the template CDK emits.
- Deployed AWS resources: what CloudFormation creates or updates in an AWS account.

When explaining a change, connect the construct to its CloudFormation resource
where practical. For example, `ec2.Vpc` synthesizes VPC, subnet, route table,
route, internet gateway, and endpoint resources; `ecs.FargateService`
synthesizes an `AWS::ECS::Service` with networking, deployment, and load
balancer configuration.

## Current-Information Rule

AWS service behavior, CDK APIs, and package versions change frequently.

Use the installed package types first when implementing against this repository:

```bash
rg -n "interface FargateServiceProps" node_modules/aws-cdk-lib
rg -n "InterfaceVpcEndpointAwsService" node_modules/aws-cdk-lib
```

When current AWS/CDK facts materially affect the answer, verify with official
AWS/CDK documentation or official package metadata. Prefer:

- AWS CDK Developer Guide
- AWS CDK API reference
- AWS service docs
- npm package metadata for version checks

If AWS MCP documentation tools are available in the active environment, use
them. If they are not available, use official docs or the installed package
types instead. Do not claim MCP tools are available when the current session has
not exposed them.

## CDK Versioning

CDK has two important packages:

- `aws-cdk-lib`: the construct library used by the app code.
- `aws-cdk`: the CLI/toolkit used to synthesize and deploy.

The CLI and construct library no longer need matching version numbers. The
practical rule is: keep the CLI new enough to understand the cloud assembly
schema emitted by the construct library. Newer CLI versions are generally the
safe direction.

For this repository, check versions with:

```bash
npm outdated
npm view aws-cdk-lib version
npm view aws-cdk version
npm view constructs version
```

## Construct-Level Guidance

Choose construct level deliberately:

- L1 constructs map directly to CloudFormation resources. Use them when CDK has
  no higher-level construct or when exact CloudFormation control is needed.
- L2 constructs model AWS resources with safer defaults and ergonomic methods.
  Prefer these for most first-party resources.
- L3 pattern constructs are useful for common production patterns, but they can
  hide details that are important for learning, security review, or unusual
  networking.

In this learning repo, explicit L2 composition is often better than an L3
pattern for first implementations. Extract custom constructs only after the
resource graph works and the duplication is real.

## Naming Guidance

Avoid explicit physical names unless there is a concrete reason:

```typescript
// Prefer this for reusable stacks.
new logs.LogGroup(this, 'AppLogGroup', {
  retention: logs.RetentionDays.ONE_WEEK,
});
```

Use explicit names only when they are part of a human workflow, external
contract, stable dashboard/search path, or learning/demo requirement. When
choosing explicit names, document the tradeoff: easier inspection versus harder
parallel deployment and possible replacement/name collision issues.

## Configuration Boundaries

Treat CDK context and environment variables as external input.

Use a small typed config boundary instead of scattering `tryGetContext` calls
through a stack:

```typescript
export interface PlatformConfig {
  readonly allowedIngressCidr: string;
  readonly maxAzs: 1;
  readonly enableEcsExec: boolean;
}
```

This is the infrastructure equivalent of the service's Zod config boundary:
normalize once, pass typed data inward.

## Networking Guidance

Make network intent visible:

- Which subnets are public?
- Which subnets host private compute?
- Is there a NAT Gateway?
- Which VPC endpoints replace NAT for private AWS service access?
- Which security group allows each edge?

For private ECS tasks without NAT, explicitly reason about required endpoints
for the current workload. For image pulls and logs, the usual minimum is:

- S3 gateway endpoint for ECR image layers.
- ECR API interface endpoint.
- ECR Docker interface endpoint.
- CloudWatch Logs interface endpoint.

Add additional endpoints only when the workload actually uses them, such as
`ssmmessages` for ECS Exec, X-Ray for ADOT trace export, or AMP/STS for
Prometheus remote write.

## IAM Guidance

Use the narrowest practical permissions at the current learning stage:

- Prefer CDK grant methods when a resource exposes them.
- Keep task execution role and task role responsibilities distinct.
- Avoid `actions: ['*']` and `resources: ['*']` unless there is a documented
  bootstrap or service limitation.
- For ECS:
  - execution role pulls images and writes logs;
  - task role is for application/sidecar AWS API calls.

## Asset Guidance

CDK Docker image assets hash the Docker build context. Keep `.dockerignore`
accurate so docs, generated output, local tool directories, and unrelated
workspaces do not perturb image hashes or slow synth/deploy.

For this repository, the ADOT collector Dockerfile lives in `adot-collector/`
and is the only repository-owned Docker image asset. Application images are
external artifacts supplied by digest-pinned private ECR references.

## Testing Guidance

Infrastructure tests should assert the behaviorally important CloudFormation
shape, not every generated detail.

Prefer focused assertions for:

- absence of NAT Gateway in the no-NAT path;
- required VPC endpoints;
- ALB scheme, listener, target group, health check path;
- ECS task networking mode and container port;
- security group ingress boundaries;
- context flags such as `enableEcsExec`.

Avoid brittle assertions on generated logical IDs unless the ID itself is the
subject under test.

## Validation Workflow

Use the narrowest useful loop while editing:

```bash
npm run build
npm test
npm run synth:ecr-contract
```

For a broader helper, use:

```bash
.ai/skills/aws-cdk-iac/scripts/validate-stack.sh
```

## Deployment Safety

Before any real deploy:

- confirm the AWS account and region;
- confirm the stack name;
- run `cdk diff`;
- verify required context values such as `allowedIngressCidr`;
- understand public exposure, IAM, data persistence, and teardown implications.

Never deploy or destroy infrastructure unless the user explicitly asks for that
operation.

## Reference Material

Read `references/cdk-patterns.md` only when deeper pattern examples are useful.
