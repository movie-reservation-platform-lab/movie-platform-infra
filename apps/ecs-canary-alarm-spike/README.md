# ECS canary deployment alarm spike

This temporary CDK application supports issue #100 (spike S1 of the walking
skeleton, movie-platform-environments#140). It observes what an ECS-native
canary deployment driven by a CloudFormation stack update does when a
deployment alarm fires. The questions are:

- What happens to the traffic split?
- What happens to the ECS deployment and to the stack status?
- Does the ECS rollback setting, the circuit breaker, or CloudFormation's own
  stack rollback change the outcome?

It is intentionally separate from the workload stack and from the reusable
per-component construct (#103). Its findings set that construct's defaults.

## What it creates

- `EcsCanarySpikeImageRepositoryStack`: one immutable ECR repository for the
  fixture image variants, created first so images exist before the service.
- `EcsCanarySpikeServiceStack`: a public-subnet VPC without NAT, an ALB open
  only to the operator prefix list, a production listener rule with blue and
  green target groups, one Fargate service using the `CANARY` strategy, an
  error-rate alarm, a watch-verdict bridge alarm, a rollback composite, and an
  ECS deployment-events log. The image is an `ImageDigest` parameter.

`lib/canary-service.ts` holds the canary deployment wiring. The engineer
wrote it as the hybrid-teaching slice of #100.

## Context

| Key | Values | Default |
|---|---|---|
| `allowedIngressPrefixListId` | customer-managed prefix list ID | required |
| `expiresOn` | `YYYY-MM-DD` teardown tag | required |
| `spikeProfile` | `halt`, `revert`, `breaker` | `halt` |
| `bridgeMissingData` | `notBreaching`, `breaching`, `missing` | `notBreaching` |
| `deploymentAlarmSet` | `all`, `members` | `all` |

## Safety boundary

The `build`, `test`, and `synth` commands run without credentials. Never
deploy this application without:

- explicit approval for the specific run;
- a passing `npm run preflight:aws`;
- a reviewed diff.

Teardown is its own approval. Do not commit account IDs, ARNs, DNS names, or
raw observer output.

## Offline commands

```bash
npm run build --workspace @movie-platform/ecs-canary-alarm-spike
npm test --workspace @movie-platform/ecs-canary-alarm-spike
npm run synth:ecs-canary-alarm-spike
npm run validate:ecs-canary-spike-tools
```

See `docs/operations/ecs-canary-deployment-alarm-spike.md` for the live
procedure and `docs/plans/ecs-canary-deployment-alarm-spike.md` for the
design.
