# Reading the infrastructure code

Start with one path from input to synthesized resource, then read its tests.
You do not need an AWS account to build, test or run the synthetic contracts.
Use Node 24 (`.nvmrc`) and npm; Docker is needed for image/router validation in
the full `npm run ci` gate.

## The two paths changed by container admission

| Read in order | Responsibility | Tests to read beside it |
| --- | --- | --- |
| [`bin/github-oidc-trust.ts`](../../bin/github-oidc-trust.ts) | Loads the operator's configuration and constructs the trust stack | [`github-oidc-trust.test.ts`](../../test/github-oidc-trust.test.ts) |
| [`github-oidc-trust-config.ts`](../../lib/config/github-oidc-trust-config.ts) | Validates unknown JSON and returns separate typed admission/deployment identities | Invalid-config table documents the rejected input and diagnostic |
| [`github-oidc-trust-stack.ts`](../../lib/github-oidc-trust-stack.ts) | Creates the provider, exact-claim roles and their permissions | Exact actions/ARNs, actual role attachments, missing/extra catalog entries |
| [`bin/infra.ts`](../../bin/infra.ts) → [`platform-config.ts`](../../lib/config/platform-config.ts) | Turns raw CDK context into the validated six-image workload configuration | [`infra.test.ts`](../../test/infra.test.ts): configuration cases |
| [`infra-stack.ts`](../../lib/infra-stack.ts) | Composes networking, imports, task containers and the ALB | Container image/health commands, startup dependencies, logging and IAM cases |

`unknown` at a parser boundary means the caller has not proved the input's type.
`PlatformConfigContext` describes that untrusted input; `PlatformConfig` describes
the validated result. TypeScript's `readonly` prevents ordinary assignment in
typed code; runtime parsers still reject invalid JSON and CLI values. For example,
audit retention must not turn the boolean `true` into one day through coercion.

The artifact catalog in [`artifact-foundation-repositories.ts`](../../lib/artifact-foundation-repositories.ts)
owns destination names and outputs. The admission stack's separate allowlist owns
permission. Adding a catalog entry intentionally does not grant the GitHub role
access to it. Tests vary the catalog to demonstrate this boundary.

## Stack and artifact ownership

| Entry point | Stack | Main responsibility |
| --- | --- | --- |
| `bin/artifact-foundation.ts` | `ArtifactFoundationStack` | Retained ECR destinations |
| `bin/github-oidc-trust.ts` | `GitHubOidcTrustStack` | GitHub OIDC identity and admission/deployment entry roles |
| `bin/audit.ts` | `AuditStack` | Audit delivery, archives and queries |
| `bin/observability.ts` | `ObservabilityStack` | Operational logs, AMP and optional Grafana |
| `bin/infra.ts` | `MovieReservationWorkloadStack` | Disposable network, ALB and shared Fargate task |

Each is an independent CDK app. `cdk.json` selects `bin/infra.ts` by default;
the named npm synth scripts select the other entrypoints. Audit and observability
export destinations that the workload imports. The ECR and trust stacks remain
separate. See [current architecture](audit-and-observability.md) for dependencies
and [the operating runbook](../operations/audit-demo.md) for deployment/teardown.

Application images arrive by immutable digest. Only `adot-collector/` and
`audit-router/` are built as repository-owned Docker assets. CDK construct IDs
contribute to CloudFormation logical IDs: changing one for cosmetic clarity can
change resource identity. Prefer clearer local helper names and comments first.

## Reading workload tests as a specification

Tests inspect synthesized CloudFormation, not running AWS resources. The local
`container`, `environment` and `resources` helpers select relevant template
properties. Exact health-command assertions document binaries available inside
the producer images; shared timing assertions document ECS's execution budget.

Three distinctions matter when interpreting assertions:

- An ECS service (`movie-platform-demo`) hosts several named containers. It is
  not the reservation application container (`movie-reservation-service`).
  [`managed-metrics-smoke.test.ts`](../../test/managed-metrics-smoke.test.ts)
  captures query arguments to enforce the distinct metric dimensions.
- The task role is shared by applications and sidecars. It allows telemetry and
  audit writes; excluding image publishing is not isolation between containers.
- ADOT is nonessential after startup, but initial collector health still gates
  application startup. The startup-dependency test asserts both facts.

The logging factory creates the same bounded FireLens driver for each app.
Routing to separate destinations is defined by container-derived tags in
[`audit-router/platform.conf`](../../audit-router/platform.conf), not by an
argument to that factory.

For a short local loop:

```sh
npm ci
npm run build
npm run test:cdk:github-oidc-trust
npm run test:cdk:workload
npm run synth:github-oidc-trust
```

The last command uses the synthetic fixture and `--no-lookups`. Inspect
`cdk.out/GitHubOidcTrustStack.template.json` to connect a construct to its emitted
resource. Synth does not prove that real credentials, images or App installations
work. Run `npm run ci` for the full repository gate before handing off a change.

## Other automation and historical documents

The three `automation/` packages have their own README, types and tests:
[account preflight](../../automation/aws-account-preflight/README.md),
[artifact copy](../../automation/artifact-copy/README.md) and
[guarded cleanup](../../automation/artifact-foundation-cleanup/README.md).
Their `src/main.ts` files connect CLI inputs to the implementations; follow the
request/result types and tests to see ordering and failure behavior.

Use `docs/architecture/` and `docs/operations/` for current behavior. Plans explain
implementation decisions at a particular revision; a historical plan or topology
may describe resources and workflows that have since changed.
