# Implementation Plan: Temporary Integrated AWS Demo

## 1. Summary

Deploy the six independently published application images and the repository-owned
ADOT collector as one disposable seven-container Fargate task. Only the Nginx web
container is exposed through the existing prefix-list-restricted ALB. Extend the
customer-managed Grafana role and dashboard so the same request can be followed
through AMP/CloudWatch metrics, CloudWatch Logs, and X-Ray.

This is a deadline-oriented demo topology. It deliberately couples deployment,
scaling, health, and rollback for all components and does not replace the
independently deployable topology tracked by issue #6.

## 2. Goals

- Preserve six immutable, digest-pinned application artifact boundaries.
- Reuse the task-local runtime contracts already published by the component repos.
- Provide explicit health/start dependencies and frontend-only public exposure.
- Preserve existing metrics while adding read-only logs and trace access in Grafana.
- Keep deploy, smoke, and teardown steps operator-driven and reviewable.

## 3. Non-goals

- Independent services, service discovery, autoscaling, or zero-downtime component releases.
- Production authentication, secrets, databases, or durable reservation state.
- S3/CloudFront frontend hosting or a production observability/retention design.
- Deploying or otherwise contacting AWS as part of this implementation.

## 4. Current State

- `lib/infra-stack.ts` already provides the no-NAT VPC, endpoints, one Fargate
  service, ALB, ADOT, AMP, CloudWatch metrics, and Managed Grafana.
- `lib/config/platform-config.ts` validates one reservation-service ECR digest.
- `lib/artifact-foundation-repositories.ts` declares only the reservation-service repository.
- The component repositories publish compatible task-local contracts on ports
  8088, 8080, 8091, 8092, 3000, and 8082.
- The web repository explicitly owns the temporary runnable Nginx image while
  retaining a static OCI bundle as its long-term contract.

## 5. Requirements And Assumptions

### Confirmed Requirements

- All six application references are private-ECR URIs pinned by SHA-256 digest.
- All images target the same concrete account and Region as the workload stack.
- Task-local calls use `127.0.0.1`; only web port 8088 is registered in the ALB target group.
- Recommendation request faults are allowlisted and enabled only for this demo.
- The agent uses the deterministic, no-LLM demo composition.

### Assumptions

- The six candidates are copied to the repository names declared by the artifact foundation.
- One task with 2 vCPU and 4 GiB is sufficient for a low-traffic demonstration.
- CloudWatch Logs Insights and X-Ray read APIs that do not support useful resource
  scoping must use `Resource: *`; mutation actions remain absent.

### Open Questions

- Live task sizing and startup timing can only be confirmed by an explicitly authorized deployment.
- Managed Grafana data-source creation may require the documented operator step.

## 6. Proposed Design

The config boundary exposes a fixed six-component catalog. Each component has
one context image-reference key, one version key, and one expected ECR repository.
The parser validates completeness, digest pinning, repository identity, and a
single deployment account/Region before stack construction.

The ECS task starts the two APIs first, their MCP dependents after health, the
agent after both MCPs are healthy, and web after the agent and reservation API
are healthy. ADOT remains nonessential so telemetry failure does not take down
the demo. Every container writes to its own one-week log group.

Grafana keeps its AMP and CloudWatch metric permissions. It gains scoped log-data
reads where IAM supports them, unavoidable discovery/result reads on `*`, and
read-only X-Ray actions. Dashboard inputs remain limited to Prometheus,
CloudWatch, and X-Ray.

## 7. Alternatives Considered

### Independent ECS services

- Pros: correct ownership, scaling, and deployment boundaries.
- Cons: materially more networking, discovery, routing, and release work.
- Decision: defer to issue #6; too large for the demo deadline.

### Single task with task-local networking

- Pros: matches the published demo contracts and minimizes moving parts.
- Cons: one failure/release affects every component and task size is coarse.
- Decision: selected as the explicit temporary shortcut.

## 8. API / Interface Changes

- CDK requires five additional image-reference/version pairs while retaining
  the existing reservation-service context keys.
- New workload outputs expose the web URL and all component log-group names.
- New `scripts/integrated-demo-smoke.sh` accepts an ALB base URL and validates
  health plus happy, slow, and controlled-error scenarios.

## 9. Data Model / Persistence Changes

None. Reservation persistence remains the existing in-memory/fake-worker demo composition.

## 10. Security, Privacy, And Abuse Considerations

- ALB ingress remains restricted by the customer-managed prefix list.
- No backend/MCP/collector port is registered with the ALB.
- No secrets enter context, task environment, output, logs, or documentation.
- Grafana receives read-only telemetry actions and no application/AWS mutation permissions.
- Request-controlled faults are restricted to the recommendation service's allowlist.
- The public web process shares the task-wide telemetry-write role with ADOT in
  this temporary topology. Telemetry is therefore not tamper-resistant audit
  evidence; issue #6 must separate these identities in the long-term topology.

## 11. Performance, Scalability, And Reliability Considerations

- Desired count one, one selected isolated subnet, and shared task resources are demo limitations.
- Essential application containers cause task replacement on failure; ADOT is nonessential and restartable.
- Health dependencies reduce startup races but do not make downstream failures independently recoverable.
- Log retention is seven days; Logs Insights queries should use narrow time ranges to bound cost.

## 12. Implementation Steps

1. Expand the persistent ECR repository catalog and assertions.
2. Replace the single-image context with a validated six-image catalog.
3. Build the seven-container task graph, log groups, health dependencies, and web-only ALB target.
4. Add minimum-read Grafana Logs/X-Ray IAM and dashboard contracts.
5. Add smoke, deploy, data-source, correlation, and teardown runbook material.
6. Run focused tests, full `npm run ci`, and offline synth only.

## 13. Testing Strategy

- Parser tests for missing, mutable, wrong-repository, cross-account, and cross-Region inputs.
- CDK assertions for repository count, task sizing, seven containers, dependencies,
  localhost configuration, health checks, logs, ALB target, IAM, and outputs.
- Dashboard validator enforces the approved source types and correlation panels.
- Smoke script self-test exercises response classification without a live endpoint.
- Full CI performs build, Jest, validators, and `--no-lookups` synth.

## 14. Rollout / Migration Plan

Deploy the persistent artifact-foundation additions first, copy and verify all
six exact digests, configure Grafana data sources, diff the workload stack, and
deploy only after explicit approval. Rollback is a reviewed release/config
reversion. Workload teardown deletes `MovieReservationWorkloadStack` while
preserving `ArtifactFoundationStack` and its admitted artifacts.

## 15. Risks And Mitigations

| Risk | Impact | Likelihood | Mitigation |
| --- | ---: | ---: | --- |
| One container prevents task readiness | High | Medium | Explicit health/start dependencies and per-container logs |
| A sibling image removes a health binary/path | High | Medium | Assert the exact published curl/wget/Node probe contracts; update infra with the image contract |
| Partial rollback mixes incompatible task-local contracts | High | Medium | Roll back the environment release and stack as one reviewed six-digest unit |
| Under-sized task | High | Medium | Conservative 2 vCPU/4 GiB initial size; inspect live metrics before resizing |
| Telemetry read permissions are broader than log groups | Medium | Certain | Separate unavoidable `*` actions, no writes, bounded runbook queries |
| Demo shortcut becomes permanent | High | Medium | Repeat limitation in code, outputs, README, runbook, and issue references |

## 16. Done Criteria

- Six retained immutable ECR repositories synthesize.
- Six exact image references are validated before synthesis.
- Exactly seven containers synthesize with frontend-only ALB exposure.
- Grafana can be configured for metrics, logs, and traces with read-only IAM.
- Offline CI and synth pass; no AWS mutation occurs.

## 17. Review Checklist

- [x] Requirements and non-goals are explicit.
- [x] Existing component runtime contracts were inspected.
- [x] Alternatives and temporary coupling are documented.
- [x] Security, cost, failure, smoke, teardown, and rollback are covered.

## 18. Handoff Prompt For Implementation Agent

Implement this plan in the issue #26 worktree. Preserve digest pinning, existing
metrics, prefix-list ingress, and offline validation. Do not contact AWS.
