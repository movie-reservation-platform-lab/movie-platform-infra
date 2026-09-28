# Audit Account Operator

This workspace owns the guarded human-operated boundary for the dedicated audit
account. It composes two reusable packages:

- `@movie-platform/audit-account-config` validates the intended account topology;
- `@movie-platform/aws-account-preflight` validates the private SSO target and
  live STS caller.

Only after both agree may the CLI read `CDKToolkit` status or execute an explicitly
authorized CDK bootstrap. Its tests inject process adapters and never call AWS.

Use the root compatibility commands documented in the
[audit-account bootstrap runbook](../../docs/operations/audit-account-bootstrap.md).
