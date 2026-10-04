# Implementation Plan: Workload Audit EventBridge Connection

Status: implementation plan for issue #83 and PR 7 of the audit demo.

## Summary

Connect the isolated workload stack to the central EventBridge bus in the
dedicated audit account. The reviewed environment release supplies the exact
bus ARN as CDK context; the workload stack validates it, creates a private
EventBridge endpoint, grants exact publication permission, and configures only
the reservation-service container for the later application integration.

## Goals

- Keep audit publication on the private workload network path.
- Restrict network endpoint and task-role permissions to `events:PutEvents` on
  the exact central custom bus.
- Reject unsafe cross-account bus configuration before synthesis.
- Give PR 8 a stable reservation-service runtime configuration contract.

## Non-goals

- Compose the EventBridge publisher inside the reservation service.
- Change authentication success or rejection behavior.
- Deploy, mutate, or inspect live AWS resources.
- Replace the current shared ECS task role or legacy FireLens audit path.
- Add alarms, live smoke checks, or release orchestration.

## Current State

- `apps/audit-account` exports `MoviePlatformAuditEventBusArn` from the audit
  account and permits configured workload-account principals to call
  `events:PutEvents`.
- `MovieReservationWorkloadStack` runs all application containers in one ECS
  task in isolated subnets. Its shared task role already owns telemetry and
  legacy Firehose permissions.
- The VPC has a shared interface-endpoint security group whose HTTPS ingress is
  limited to the ECS service security group.
- `lib/config/platform-config.ts` validates untrusted CDK context before the
  stack receives `PlatformConfig`.
- The reservation-service audit SDK accepts an exact bus ARN and bounded
  timeout, but service runtime composition remains a later repository slice.

## Proposed Design

Add `auditEventBusArn` and an optional bounded `auditPublishTimeoutMs` to the
platform context. Resolve them into a typed audit publisher configuration.
Require an AWS EventBridge custom-bus ARN in the deployment Region whose owner
is not the workload account. Reject wildcards and the AWS default bus.

The private environment/release process reads the audit stack output and passes
the exact value as CDK context. The infrastructure repository does not query AWS
during synthesis and does not use a CloudFormation export, because exports are
not importable across accounts.

Create an EventBridge interface endpoint using the existing isolated subnet
selection and endpoint security group. Its endpoint policy permits only
`events:PutEvents` on the configured bus ARN. Add the matching identity policy
to the shared ECS task role. The role remains technically available to every
container in the task; only `movie-reservation-service` receives:

- `AUDIT_PUBLISHER=eventbridge`
- `AUDIT_EVENT_BUS_ARN=<validated exact ARN>`
- `AUDIT_PUBLISH_TIMEOUT_MS=<bounded value>`
- `AUDIT_STDOUT_COMPARISON_MIRROR=true`

The stdout mirror is temporary rollout configuration and is removed by PR 10.

## Alternatives Considered

- **CloudFormation cross-stack export:** simple within one account and Region,
  but unsupported across the workload and audit accounts. Rejected.
- **AWS SDK lookup during CDK synthesis:** can discover the live stack output,
  but makes offline CI and local synth credential-dependent. Rejected.
- **Reviewed explicit release input:** keeps synthesis deterministic and makes
  the cross-account handoff visible. Selected.

## Security And Operations

- Three controls align on the same path: endpoint security-group ingress,
  endpoint action/resource policy, and task-role action/resource policy.
- The audit-account bus resource policy remains the destination-side control.
- No credentials or manually copied private response are injected into ECS.
- A reviewed workload change set is required before a separately authorized
  deployment. Rollback uses the previous workload assembly/configuration.
- The interface endpoint adds hourly and data-processing cost while deployed.

## Implementation Steps

1. Validate the cross-account bus configuration.
   - Files: `lib/config/platform-config.ts`, `bin/infra.ts`, `test/infra.test.ts`.
   - Change: parse exact bus ARN and bounded timeout into typed configuration.
   - Verification: focused valid/missing/malformed/wrong-Region/same-account/
     default-bus/wildcard tests.

2. Add the private EventBridge publication path.
   - Files: `lib/infra-stack.ts`, `test/infra.test.ts`.
   - Change: interface endpoint, exact endpoint policy, and exact task-role
     permission.
   - Verification: synthesized endpoint service, subnet/security-group binding,
     action, and resource assertions.

3. Inject the reservation-service contract.
   - Files: `lib/infra-stack.ts`, `test/infra.test.ts`.
   - Change: add the four publisher variables only to the reservation-service
     container.
   - Verification: positive reservation assertion and negative assertions for
     every other container.

4. Update offline and operator inputs.
   - Files: root scripts/CI fixtures as needed, `docs/operations/audit-demo.md`,
     and the plan index.
   - Change: document how the reviewed environment release carries the audit
     stack output into workload CDK context.
   - Verification: offline synth with synthetic account IDs and `--no-lookups`.

## Testing Strategy

- Unit-test runtime configuration validation at the CDK boundary.
- Use focused CDK assertions for endpoint, endpoint policy, IAM, and container
  environment contracts without comparing the full template.
- Build and test the root infrastructure package.
- Run offline workload synth, workspace-boundary validation, `git diff --check`,
  and the relevant repository CI commands.

## Hybrid Ownership

Learning target: understand how network, endpoint-policy, IAM, and runtime
configuration controls combine into one least-privilege AWS API path.

- **AI owns:** configuration/CDK scaffolding around the exercise,
  documentation, mechanical tests, and verification.
- **Engineer owns:** one focused CDK assertion proving that the EventBridge
  endpoint policy permits only `events:PutEvents` on the configured central bus
  ARN.
- **Done evidence:** the focused assertion passes with all configuration tests,
  root build/tests, offline synth, and repository checks.
- **Support level:** guided.

## Done Criteria

- Unsafe bus inputs fail before synthesis.
- EventBridge traffic has an isolated-subnet interface endpoint with exact
  endpoint and task-role permissions.
- Only reservation service receives publisher configuration.
- Existing image selection and application behavior remain unchanged.
- Documentation defines the cross-account output handoff and approval boundary.
- No AWS mutation occurs in implementation or CI.
