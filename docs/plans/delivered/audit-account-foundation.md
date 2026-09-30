# Implementation Plan: Audit Account Foundation

> Status: delivered by issue #68 / PR #70. This is historical implementation
> context; use current app, architecture and operation docs for today's
> commands.

## 1. Summary

Create an independently buildable `@movie-platform/audit-account` CDK app and
the operator workflow needed to target a dedicated audit member account safely.
The app will synthesize a stable, currently empty `AuditAccountStack`; pipeline
resources remain outside this PR.

The existing AWS account preflight becomes a reusable workspace package. The
audit app consumes that package, validates its own topology configuration, and
requires the live SSO target to match the configured audit account and Region
before a status or bootstrap operation can proceed.

## 2. Goals

- Establish the real `apps/audit-account` workspace and stable stack identity.
- Validate management, audit, and workload account roles at one runtime boundary.
- Reuse the existing SSO/profile/STS safety gate without duplicating it.
- Provide credential-free unit tests and offline synthesis.
- Document member-account creation, delegated administration, access, cost, and
  teardown prerequisites.

## 3. Non-goals

- Create Security Lake, EventBridge, Firehose, S3, Glue, KMS, or query resources.
- Create an AWS account or register a delegated administrator from CI.
- Run CDK bootstrap, deploy, or destroy while implementing or validating the PR.
- Define the reusable ingestion construct planned for a later slice.

## 4. Current State

The workspace foundation and `apps/legacy-audit-demo` are present. The
credential-source and caller-identity safety contract currently lives in
`automation/aws-account-preflight`, where it exposes `validateAwsAccess` for a
future consumer but is not an npm workspace package.

## 5. Proposed Design

### Workspace boundaries

- `packages/aws-account-preflight` owns generic, read-only validation of the
  operator target file, AWS CLI v2 SSO profile, and STS caller identity.
- `packages/audit-account-config` owns the topology contract shared by the app
  and operator.
- `apps/audit-account` owns only the CDK composition root and stable stack identity.
- `automation/audit-account-operator` compares topology with the validated
  operator target and owns the guarded commands.
- Root scripts remain compatibility and CI orchestration entrypoints.

This keeps dependencies in the enforced direction:

```text
apps/audit-account -> packages/audit-account-config
automation/audit-account-operator -> packages/audit-account-config
automation/audit-account-operator -> packages/aws-account-preflight
```

### Configuration boundary

The shared configuration package reads a JSON document as `unknown` and validates:

- one management account ID;
- one different audit account ID;
- one or more unique workload account IDs distinct from both;
- the supported initial Region, `eu-central-1`; and
- an exact key set, rejecting silent misspellings.

Real topology files remain outside Git. Tests and offline synth use obviously
synthetic account IDs.

### CDK boundary

`apps/audit-account/bin/audit-account.ts` creates `AuditAccountStack` with explicit account and
Region from validated configuration. The stack intentionally has no resources
in this PR. Synth proves the app boundary and stable stack identity without
pretending that the later ingestion design already exists.

### Operator boundary

The operator CLI validates both inputs before doing anything else:

1. validate the audit topology file;
2. validate the private SSO target and live STS caller through the reusable
   preflight package;
3. require its account and Region to equal the configured audit target;
4. allow read-only status or an explicitly requested bootstrap operation.

Bootstrap remains a human-authorized live action and is never run in CI.

## 6. Alternatives Considered

### Duplicate preflight logic in the app

Rejected because credential and caller checks would drift between two security
boundaries.

### Import source directly from `automation/`

Rejected because the app would not build independently and the dependency would
sit outside the workspace graph.

### Add pipeline resources now

Rejected because the Firehose/Security Lake feasibility checkpoint has not run
and this PR's review claim is account targeting and operator safety.

## 7. Implementation Steps

1. Move the generic preflight into `packages/aws-account-preflight` while
   preserving its CLI and tests.
2. Add the audit-account workspace manifest, TypeScript/Jest/CDK configuration,
   composition root, empty stack, and synthetic offline fixture.
3. Implement and test the runtime topology parser as the engineer-owned hybrid
   slice.
4. Add the target-match and operator command adapters under
   `automation/audit-account-operator` with credential-free fakes.
5. Add root scripts, CI checks, workspace documentation, and the operator runbook.
6. Run focused checks, offline synth, workspace validation, and full local CI.

## 8. Security and Operational Constraints

- No real account IDs, root emails, generated role suffixes, tokens, or
  credentials enter Git or test output.
- Account IDs are identifiers and remain strings.
- Status is read-only. Bootstrap requires a separately authorized operator act.
- The management account performs Security Lake delegated-administrator
  registration; the audit member account is the delegated administrator.
- Removing delegated administration is destructive to the data lake and is not
  part of this slice.

## 9. Done Criteria

- Both workspaces build and test independently.
- The audit app synthesizes `AuditAccountStack` offline with synthetic inputs.
- Configuration and target mismatch tests fail before an AWS mutation command.
- Existing preflight behavior and root commands remain compatible.
- The runbook clearly separates management-account and audit-account actions.
- Repository CI-equivalent checks pass without AWS credentials.
