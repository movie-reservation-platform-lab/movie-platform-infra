# Infrastructure Architecture

This folder captures durable architecture notes for the standalone CDK
infrastructure repository.

## Current Stack Boundary

The current CDK stack is `GoldenPathDemoStack`. It models the first
production-shaped AWS demo workload:

- internet-facing Application Load Balancer;
- two-AZ VPC with public and isolated subnet groups;
- private isolated ECS/Fargate task for the reservation API;
- digest-pinned application image imported from private ECR;
- repository-owned ADOT collector image asset;
- CloudWatch logs, X-Ray traces, AMP metrics, and Managed Grafana dashboarding;
- VPC endpoints for private AWS service access;
- customer-managed IPv4 prefix list for ALB and Grafana ingress.

The stack intentionally does not yet own:

- frontend S3/CloudFront hosting;
- recommendation API, agent, or MCP ECS services;
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
  is intentionally introduced.
- Public ingress is restricted by customer-managed prefix list ID, not by
  changing CIDR context values.
- Observability is part of the demo topology, but DORA delivery telemetry
  belongs to environment/deployment events, not application request telemetry.

## Detailed Notes

- [AWS Resource Topology](./aws-resource-topology.md)
