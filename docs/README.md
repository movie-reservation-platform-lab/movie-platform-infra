# Movie Platform Infra Docs

This folder owns documentation for the standalone AWS CDK infrastructure
repository. The root `README.md` stays as the quick start and command reference;
this folder holds durable design, planning, and operations material.

## Sections

- `plans/`: issue-level implementation plans and review notes before
  non-trivial infrastructure changes.
- `architecture/`: durable infrastructure design notes, stack boundaries,
  resource topology, and contract decisions.
- `operations/`: deployment runbooks, teardown, smoke checks, troubleshooting,
  and manual AWS prerequisites.

## Documentation Ownership

Keep documentation in this repository scoped to platform infrastructure:

- AWS CDK stack design and synthesized CloudFormation behavior.
- Network, IAM, ECS/Fargate, observability, and teardown decisions.
- Infrastructure consumption of immutable application artifacts.
- Manual operator steps required before or after CDK deployment.

Do not document application source internals here except where they are part of
the infrastructure contract, such as image digest selection, container ports,
health endpoints, or environment variables consumed by ECS tasks.

## Source History

Some content was adapted from the original `golden-path-ecs-template`
documentation. This repository is now the source of truth for standalone
platform infrastructure docs; golden-path remains migration history.
