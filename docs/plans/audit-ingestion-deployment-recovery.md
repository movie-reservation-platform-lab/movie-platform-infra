# Implementation Plan: Audit Ingestion Deployment Recovery

## 1. Summary

Correct two contracts disproved by the first live deployment of
`AuditAccountIngestionStack`:

1. Firehose must not be created before its conversion-schema Glue permissions
   exist.
2. Deleting or rolling back the ingestion stack must be able to delete its
   EventBridge bus without retained child resources blocking it.

The recommended change embeds the Glue policy in the conversion IAM role and
uses `RemovalPolicy.DESTROY` for the ingestion stack's bounded EventBridge
archive and target DLQs.

## 2. Goals

- Make the CloudFormation dependency graph enforce usable Glue permissions
  before Firehose validation.
- Make initial-create rollback and deliberate stack deletion self-contained.
- Add focused synthesized-template regressions for both live failures.
- Document that operators must inspect or drain operational buffers before a
  deliberate stack deletion.

## 3. Non-goals

- Change the OCSF contract, routing pattern, Security Lake custom source, data
  retention, or workload publication path.
- Add deployment automation, custom resources, waits, or new dependencies.
- Redeploy AWS resources as part of the code change.

## 4. Current State

`packages/audit-ingestion/src/audit-ingestion.ts` creates the conversion role,
then uses `role.addToPolicy`. CDK emits that statement as a separate
`AWS::IAM::Policy`. Firehose references the role and depends on Lake Formation
grants, but does not depend on the separate policy. In the live failure,
Firehose entered `CREATE_IN_PROGRESS` while the policy was still creating and
failed `glue:GetTableVersions` validation.

`apps/audit-account/lib/audit-account-ingestion-stack.ts` passes
`RemovalPolicy.RETAIN` to the reusable construct. This retains both the archive
and DLQ. During rollback, the retained archive kept its AWS-managed EventBridge
rule, which prevented CloudFormation from deleting the event bus and left the
stack in `ROLLBACK_FAILED`.

## 5. Requirements and Assumptions

### Confirmed Requirements

- Preserve the exact Glue actions and resource scope.
- Preserve archive and DLQ retention periods during normal operation.
- Keep Security Lake as the retained audit record; the archive and DLQ are
  bounded recovery buffers.
- Keep all local verification offline and credential-free.

### Assumptions

- Stack deletion remains an explicit release action preceded by archive/DLQ
  inspection when the stack has carried traffic.
- Initial-create rollback should discard newly created operational buffers so
  it can complete without manual resource cleanup.

### Open Questions

None. The live CloudFormation events and teardown behavior determine both fixes.

## 6. Proposed Design

Define the Glue `PolicyDocument` through the IAM role's `inlinePolicies` prop.
CloudFormation then creates the permissions as part of `AWS::IAM::Role`, rather
than as an independently scheduled `AWS::IAM::Policy`. Firehose already uses
that role ARN, so its implicit role dependency covers the permissions too.

Compose `AuditIngestion` with `RemovalPolicy.DESTROY` in the audit-account app.
The archive's managed rule is deleted with the archive before the event bus,
and the DLQ cannot become an untracked orphan. The underlying Security Lake
data lifecycle remains unchanged.

## 7. Alternatives Considered

### Alternative A: Add an explicit dependency on the generated default policy

- Pros: very small synthesized-template change.
- Cons: keeps permissions in a separately created IAM policy and still relies
  on attachment propagation after that resource completes.
- Decision: rejected in favor of making the policy part of role creation.

### Alternative B: Retain the event bus together with the archive

- Pros: CloudFormation could finish while leaving the replay pair intact.
- Cons: leaves sensitive, billable, unmanaged resources after rollback and
  requires manual cleanup for every stack deletion.
- Decision: rejected.

### Alternative C: Split archive and DLQ removal-policy props

- Pros: allows retaining the DLQ while destroying the archive.
- Cons: expands the public construct API and still creates an orphan during
  rollback. No current consumer requires different policies.
- Decision: defer until a real consumer needs independently owned buffers.

## 8. API / Interface Changes

None. `AuditIngestionProps.removalPolicy` remains available and keeps its
existing default. The audit-account composition changes its selected value.

## 9. Data Model / Persistence Changes

None. Normal retention stays seven days for the archive, fourteen days for the
DLQ, and thirty days for Security Lake objects.

## 10. Security, Privacy, and Abuse Considerations

The Glue permissions remain limited to `GetTable`, `GetTableVersion`, and
`GetTableVersions` on the exact catalog, database, and table. Deleting buffers
with the stack avoids unowned copies of submitted audit payloads. Operators
must inspect or drain nonempty buffers before intentional teardown.

## 11. Performance, Scalability, and Reliability Considerations

Resource count falls by one IAM policy. Runtime throughput and buffering do not
change. Create rollback and stack deletion become deterministic without manual
archive/DLQ cleanup.

## 12. Implementation Steps

1. Embed the conversion policy in the role.
   - Change: replace `role.addToPolicy` with a named inline policy passed during
     role construction.
   - File: `packages/audit-ingestion/src/audit-ingestion.ts`.
   - Verification: assert Glue actions are inside the conversion role and the
     Firehose schema references that role.

2. Correct audit-account buffer lifecycle.
   - Change: compose the reusable construct with `RemovalPolicy.DESTROY` and
     clarify the nearby lifecycle comment.
   - File: `apps/audit-account/lib/audit-account-ingestion-stack.ts`.
   - Verification: assert archive and SQS queue deletion/update-replacement
     policies are `Delete`.

3. Document the operational contract.
   - Change: state that stack deletion removes the archive and target DLQs and
     requires a pre-delete contents check after traffic has flowed.
   - Files: `packages/audit-ingestion/README.md` and/or
     `apps/audit-account/README.md`.
   - Verification: inspect the documentation diff.

4. Run focused and repository-boundary verification.
   - Commands: package build/test, audit-account build/test and synth, workspace
     boundary validation, and `git diff --check`.

## 13. Testing Strategy

- Package regression: synthesized conversion role contains the exact Glue
  policy and each Firehose schema points at that role.
- App regression: archive and DLQ synthesize deletion-safe lifecycle policies.
- Existing routing, IAM, partitioning, alarms, and config tests remain green.
- Offline synth confirms the deployable template contains the intended graph.

## 14. Rollout / Migration Plan

Merge the fix before another live deployment. Synthesize a fresh assembly and
review `cdk diff --change-set=false`. After confirming the failed stack is gone,
deploy only `AuditAccountIngestionStack` under a new explicit AWS approval.
If deployment fails again, allow automatic rollback and inspect events before
any retry.

## 15. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
| --- | ---: | ---: | --- |
| IAM propagation still delays Firehose validation | Medium | Low | Create permissions atomically with the role; inspect live events if AWS still rejects validation. |
| Intentional stack deletion loses queued events | High | Low | Require archive/DLQ inspection or drain in the teardown runbook before deletion. |
| Lifecycle regression reintroduces retained archive | High | Low | Assert top-level CloudFormation deletion policies in the app test. |

## 16. Done Criteria

- Glue permissions synthesize inside the conversion role.
- Firehose no longer races a separate Glue IAM policy resource.
- Archive and DLQ delete with `AuditAccountIngestionStack`.
- Focused builds, tests, synth, workspace validation, and diff checks pass.
- A fresh live diff is reviewed before any redeployment.

## 17. Review Checklist

- [x] Requirements and non-goals are explicit.
- [x] Existing code and live failure evidence were checked.
- [x] Alternatives, security, reliability, tests, and rollback are covered.
- [x] Implementation steps name concrete files and verification.

## 18. Handoff Prompt for Implementation Agent

```text
Implement docs/plans/audit-ingestion-deployment-recovery.md.

Keep the Glue permissions exact, preserve normal retention periods, add focused
CDK assertions, update lifecycle documentation, and introduce no dependencies.
Run the package and audit-account build/tests, offline ingestion synth,
workspace-boundary validation, and git diff --check.
```
