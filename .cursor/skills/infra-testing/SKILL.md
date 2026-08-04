---
name: infra-testing
description: Use when creating, refactoring, reviewing, or explaining Jest/CDK assertion tests, shell smoke-tool self-tests, dashboard validation, and offline synth contracts in this infrastructure repository.
---

# Infrastructure Testing

Use this skill when work changes infrastructure behavior, CDK configuration,
validation scripts, dashboards, or CI checks in this repository.

Pair with:

- `.ai/rules/teaching-mode.md` when explaining testing concepts.
- `.ai/skills/aws-cdk-iac/SKILL.md` when assertions depend on CloudFormation,
  ECS, IAM, networking, assets, or synth/deploy behavior.
- `.ai/skills/typescript/SKILL.md` when adding typed test helpers.

## Core Testing Preference

- Prefer behaviorally meaningful CloudFormation assertions over snapshots.
- Assert deployment contracts, not incidental generated details.
- Keep shell smoke tooling self-testable without AWS credentials where possible.
- Keep CI synth offline with `--no-lookups`.
- Use fake account, Region, repository, and digest values for contract tests.

## What To Test

For CDK stack behavior, prefer focused assertions for:

- public ingress boundaries and rejection of `0.0.0.0/0`;
- absence or presence of NAT and VPC endpoints;
- ALB scheme, listener, target group, health check, and routing;
- ECS task definition shape, container environment, image source, and logging;
- IAM distinction between task execution role and task role;
- optional context such as `enableEcsExec` and metric export cadence;
- imported application image contract and service version propagation;
- outputs used by smoke tooling and dashboards.

For scripts, validate:

- shell syntax with `bash -n`;
- deterministic `--self-test` paths;
- required argument and environment validation;
- bounded polling, clear timeout messages, and useful report output.

For dashboards, validate:

- JSON syntax;
- required panels or datasource inputs;
- stable metric names, labels, and environment filters.

## Anti-Patterns

- Do not assert every generated logical ID.
- Do not add broad snapshots for large templates unless reviewing the snapshot
  is realistically useful.
- Do not require AWS credentials for CI checks intended to run on public pull
  requests.
- Do not make tests depend on sibling application repositories.

## Verification Workflow

Use the narrowest loop while editing:

```bash
npm run build
npm test
npm run synth:ecr-contract
```

Before handing back infrastructure changes, prefer:

```bash
npm run ci
```
