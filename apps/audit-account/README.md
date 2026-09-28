# Audit Account Application

This workspace is the composition root for infrastructure owned by the dedicated
audit member account. The current foundation establishes the stable
`AuditAccountStack` identity. It intentionally creates no AWS resources yet.

Run credential-free checks from the repository root:

```bash
npm run build --workspace @movie-platform/audit-account
npm test --workspace @movie-platform/audit-account
npm run synth:audit-account
```

Offline synth uses the synthetic fixture under `test/fixtures` and `--no-lookups`.
It does not contact or mutate AWS.

Live operator commands are owned by
[`automation/audit-account-operator`](../../automation/audit-account-operator/README.md)
and require two private files:

- the generic SSO target described by `packages/aws-account-preflight`; and
- an audit topology file selected with the absolute
  `MOVIE_PLATFORM_AUDIT_ACCOUNT_CONFIG_FILE` path.

Follow the [audit-account bootstrap runbook](../../docs/operations/audit-account-bootstrap.md)
before using them. Bootstrap is a live AWS mutation and is never part of CI.
