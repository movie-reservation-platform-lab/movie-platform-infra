# Legacy audit demo

This private npm workspace contains the existing custom audit lake. It remains
deployable as `AuditStack` while the EventBridge-to-Security Lake replacement is
built and compared. Relocating it here does not change its CloudFormation
resources, logical IDs, outputs, retention, or deletion behavior.

Run the package-local commands from the repository root:

```bash
npm run build --workspace @movie-platform/legacy-audit-demo
npm test --workspace @movie-platform/legacy-audit-demo
npm run synth --workspace @movie-platform/legacy-audit-demo
npm run cdk --workspace @movie-platform/legacy-audit-demo -- diff AuditStack --change-set=false
```

The existing root commands remain compatibility wrappers:

```bash
npm run test:cdk:audit-foundations
npm run synth:audit
npm run cdk:audit -- diff AuditStack --change-set=false
```

Synthesis is credential-free and uses a fake account with `--no-lookups`.
Diff, deploy, and destroy commands retain their existing operator requirements;
never run live mutations as part of ordinary PR validation.
