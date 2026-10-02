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

## Current Review Work

- [Reusable audit ingestion package (PR 5)](./audit-ingestion-package.md):
  proposed package boundary, hybrid ownership, and quarantine retest gate.
- [EventBridge to Security Lake audit demo](./eventbridge-security-lake-audit-demo.md):
  cross-repository SDK, dedicated audit account, managed ingestion, migration,
  teardown, and thirteen-PR delivery plan.
- [Security Lake Firehose feasibility checkpoint](./security-lake-firehose-feasibility.md):
  offline implementation and separately approved live evidence for the preferred
  EventBridge-to-Firehose Security Lake path.
- [Five-backend telemetry wiring](./five-backend-telemetry-wiring.md):
  advisory signal contract and repository-side telemetry wiring coordination.
- [Private Tempo](./private-tempo.md): optional private trace backend rehearsal
  that remains separate from the current required observability path.
- [Service alerts](./service-alerts.md): symptom-level alert and dashboard work.

## Delivered Plans

Delivered plans live in [`delivered/`](./delivered/) as implementation history.
Prefer current [architecture](../architecture/README.md) and
[operations](../operations/README.md) documentation when behavior differs.
