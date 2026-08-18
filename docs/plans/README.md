# Infrastructure Plans

Use this folder for active implementation plans before non-trivial
infrastructure changes. A good plan should let another engineer or coding agent
implement the slice without rediscovering the full repository context.

## Plan Lifecycle

- Keep active or backlog plans directly in `docs/plans/`.
- When the owning issue or pull request lands, add a delivered-status banner and
  move the plan to `docs/plans/delivered/`.
- Treat delivered plans as implementation history, not current architecture or
  operational truth.
- Move durable decisions and operating procedures into `docs/architecture/`,
  `docs/operations/`, or an ADR before compacting or deleting an old plan.
- Periodically remove delivered plans whose useful context has been captured by
  durable documentation and Git history.

## When To Add A Plan

Add a plan for work that changes any of:

- CDK stack topology, VPC layout, ECS/Fargate services, ALB routing, or storage.
- IAM permissions, public exposure, security groups, prefix lists, or secrets
  handling.
- Artifact contracts consumed from application repositories.
- Observability architecture, dashboards, smoke checks, or telemetry retention.
- Deployment, teardown, rollback, or promotion workflow.
- Cross-repository contracts with `movie-platform-environments` or app repos.

Small documentation-only edits or narrow test fixes usually do not need a plan.

## Plan Template

```md
# Implementation Plan: <Name>

## Summary

What changes and why.

## Goals

- ...

## Non-goals

- ...

## Current State

Relevant files, constructs, scripts, tests, and docs.

## Proposed Design

Recommended approach and why it fits this repository.

## Alternatives Considered

- Option A:
- Option B:

## Security And Operations

IAM, networking, public exposure, secrets, teardown, rollback, and cost.

## Implementation Steps

1. Change:
   - Files:
   - Verification:

## Testing Strategy

Unit tests, CDK assertions, synth contracts, script checks, and smoke tests.

## Done Criteria

- ...
```

## Current Planning Priorities

- [Standalone-Account Identity Center And Grafana Access Bootstrap](./standalone-account-identity-center-bootstrap.md):
  establish the approved identity, preflight, lifecycle, testing, and staged
  release contract for issue #14 before implementation begins.
- [Prefix List Ingress Allowlist](./prefix-list-ingress-allowlist.md): replace
  changing CIDR context with one externally owned list shared by the ALB and
  Managed Grafana.
- Expand from the single reservation workload to the integrated web, agent,
  recommendation, and MCP topology after application artifact contracts are
  ready.
- Consume environment manifest selections from `movie-platform-environments`
  once the manifest schema and validation workflow are stable.
- Add RDS Postgres and migration-task infrastructure as a separate slice.
- Add SQS worker-signaling infrastructure as a separate slice.
- Keep ingress allowlisting, teardown, observability, and cost controls explicit
  in every design.
