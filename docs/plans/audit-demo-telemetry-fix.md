# Audit demo telemetry fix

Tracking: [#43](https://github.com/movie-reservation-platform-lab/movie-platform-infra/issues/43).
Base: `14a354d`, the infrastructure revision used by the demo.

The collector appends `remote_write` to the imported AMP workspace URL,
omitting `api/v1/`. Both application and ECS metric exporters therefore receive
HTTP 404 and drop samples. Grafana's X-Ray datasource health check calls
`GetGroups`, which is missing from its existing read policy.

1. Add synthesized-template regression assertions for the imported AMP endpoint
   plus exact `api/v1/remote_write` suffix, and the exact X-Ray read action set
   including `xray:GetGroups`. Reject wildcard actions and write/admin additions.
   Run the focused tests against unchanged production code and record failures.
2. Correct the suffix in `lib/infra-stack.ts` and add `xray:GetGroups` to the
   existing read statement in `lib/observability-stack.ts`. Keep its existing
   resource scope and role unchanged; no dependency or helper API changes.
3. Document the symptoms, recovery checks, and historical metric loss in
   `docs/operations/audit-demo.md`. Run focused tests, build, then `npm run ci`.

Deployment is a separate operator action: review fresh observability/workload
assemblies, update the policy and workload, then verify datasource health and
new AMP samples after ECS stabilizes. The workload change rolls ECS tasks;
application image digests remain unchanged. Dropped samples are not restored.
An earlier assembly rolls back these edits but also restores their defects.
Audit resources do not need an update for these fixes.

Validation completed on 2026-09-08:

- Before the production edits, the two targeted assertions failed only for the
  old `remote_write` suffix and the missing `xray:GetGroups` action.
- After the edits, workload and audit-foundation tests passed (33 tests), and
  `npm run build` passed.
- `npm run ci` passed: 256 Jest tests, automation typechecks, collector and
  audit-router container checks, smoke-tool self-tests, dashboard validation,
  and all five offline synth contracts. Existing ts-jest module warnings and
  CDK feature-flag notices remain.
