# Infrastructure Architecture

This folder captures durable architecture notes for the standalone CDK
infrastructure repository.

## Current Stack Boundaries

The repository has independent CDK applications because artifacts, compute,
operational telemetry and audit evidence have different lifecycles:

- `ArtifactFoundationStack` owns six persistent, account-local and Region-local
  ECR destinations for the integrated demo images. Termination
  protection and retain policies keep it outside routine demo teardown.
- `MovieReservationWorkloadStack` owns the disposable, production-shaped AWS
  demo workload:

  - internet-facing Application Load Balancer;
  - two-AZ VPC with public and isolated subnet groups;
  - private isolated ECS/Fargate task containing six applications, ADOT and FireLens;
  - six digest-pinned application images imported from foundation repositories;
  - repository-owned collector/router assets and imported telemetry destinations;
  - VPC endpoints for private AWS service access; and
  - customer-managed IPv4 prefix list for ALB and Grafana ingress.
- `ObservabilityStack` owns operational log groups, AMP and optional Grafana.
- `AuditStack` owns Firehose, S3 evidence, CloudTrail, Glue and Athena.

The [audit and observability architecture](./audit-and-observability.md) is the
current source of truth for these ownership boundaries and correlation paths.

The current applications intentionally do not yet own:

- long-term frontend S3/CloudFront hosting;
- independently deployable recommendation API, agent, or MCP ECS services;
- RDS, migrations, or SQS worker signaling;
- environment manifest selection or promotion automation;
- production account structure, IAM Identity Center lifecycle, or organization
  guardrails.

## Core Design Principles

- Application repositories publish immutable artifacts. Infrastructure consumes
  image references pinned by digest and must not build sibling application
  source.
- Public CI remains credential-free. Synth contracts use fake account and image
  values with `--no-lookups`.
- AWS environments must be disposable and cost-aware until promotion automation
  is intentionally introduced. Routine teardown destroys the workload while
  preserving the small artifact foundation and `CDKToolkit`.
- Public ingress is restricted by customer-managed prefix list ID, not by
  changing CIDR context values.
- Observability is part of the demo topology, but DORA delivery telemetry
  belongs to environment/deployment events, not application request telemetry.

## Detailed Notes

- [AWS Resource Topology](./aws-resource-topology.md)
- [Audit and Observability](./audit-and-observability.md)
