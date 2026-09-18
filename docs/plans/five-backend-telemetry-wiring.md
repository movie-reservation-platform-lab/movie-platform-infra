# Implementation Plan: Five-backend telemetry wiring

Tracking: [issue #57](https://github.com/movie-reservation-platform-lab/movie-platform-infra/issues/57).

## 1. Summary

Complete task-local telemetry wiring for the reservation service, reservation
agent, reservation MCP, recommendation MCP, and recommendation service. Define
an advisory semantic contract now, wait for each producer to provide observed
local payload evidence, and then deliver the infrastructure code, offline
contract validation, and documentation as one combined infrastructure pull
request.

Producer instrumentation remains owned and reviewed in the five sibling
repositories. Runtime release composition remains independent of source builds,
selects immutable image digests, and deploys the compatible infrastructure and
producer set in one coordinated rollout.

## 2. Goals

- Give all five producers private OTLP/HTTP paths to the task-local collector.
- Route application metrics to AMP and CloudWatch and traces to X-Ray plus
  optional Tempo.
- Preserve producer-native signal names while standardizing operational meaning,
  identity, bounded dimensions, correlation, and missing-data semantics.
- Verify exact emitted payloads before changing collector filters or queries.
- Prove offline compatibility and provide a staged cross-service evidence matrix.
- Keep application traffic available after a runtime telemetry failure.

## 3. Non-goals

- A universal metric name or cross-language telemetry library.
- Browser OpenTelemetry instrumentation.
- Dashboard and alert implementation owned by issue #58.
- New telemetry backends, public receivers, or broad IAM permissions.
- Live AWS deployment, fault injection, Grafana mutation, artifact publication,
  or environment promotion without separate authorization.
- Making the advisory `v0` contract a formal compatibility gate.

## 4. Baseline before implementation

At planning time, `lib/infra-stack.ts` injected OTLP configuration into four
producers and assigned task-local ports 4318-4321. Reservation MCP had no OTEL
environment or collector receiver, so `adot-collector/adot-config.yaml` and
`tempo-overlay.yaml` routed four producers only.

All six application containers share one ECS task. The ADOT container must be
healthy during startup and is nonessential afterward. Metrics already flow to
AMP and CloudWatch; traces flow to X-Ray and optionally Tempo. Structured stdout
logs use the existing FireLens path.

Current collector processors normalize service/environment labels, remove
churn-heavy AMP resource labels, and include a fixed set of application metric
names. Those filters can silently discard new valid producer metrics unless
audited against actual payloads. ECS task and container metrics already exist,
but consumers must keep shared-task totals distinct from per-container values.

No issue-57 plan or signal contract existed before the planning Q&A. The
advisory contract now lives at
`docs/observability/service-signal-contract.md`; the implementation adds the
fifth receiver and reconciles all 21 observed metric families.

## 5. Requirements and Assumptions

### Confirmed requirements

- Use an advisory minimum semantic contract, not uniform instrument names.
- Organize coverage into initial integration, producer-specific targets, and
  future improvements.
- Deployment configuration owns canonical service/environment/version identity.
- Distinguish active, idle, and missing/stale telemetry.
- Use per-signal bounded metric-attribute allowlists.
- Require connected W3C traces across participating backend boundaries.
- Use a small shared structured-log envelope, with validated tenant and real AWS
  correlation identifiers included on a best-effort basis.
- Use expected, emitted, accepted, and queryable evidence stages.
- Preserve startup collector readiness and runtime fail-open behavior.
- Deliver issue #57 as one combined infrastructure PR after producer evidence is
  available because the user is time constrained.

### Assumptions

- Existing producer APIs, MCP tool contracts, health behavior, and business data
  contracts remain unchanged.
- OTLP remains HTTP/protobuf over loopback; reservation MCP can use port 4322.
- Producer-local tests can capture exact exported payloads without credentials or
  live AWS dependencies.
- Exact native and AMP names remain provisional until observed.
- `tenant.id` remains outside metric labels until a tenancy/cardinality review.

### Resolved evidence questions

- Producer PRs agent #22, reservation MCP #15, recommendation MCP #14,
  recommendation service #18, and reservation service #43 provide exact native
  names, units, temporalities, attributes, and idle/zero behavior.
- The combined collector accepts all 21 observed metric families through five
  private receivers. Backend-translated names and freshness remain a live
  acceptance boundary rather than an offline claim.

## 6. Proposed Design

Keep direct CDK and collector composition. Add one dedicated reservation-MCP
receiver and mirror the existing per-producer metrics and trace routing. Do not
introduce a domain/application/infrastructure directory hierarchy for declarative
collector or CDK code.

Treat the advisory semantic contract as the integration port. Each producer's
framework-specific instrumentation is its adapter. The collector accepts the
observed payload, applies only documented normalization/cardinality controls, and
routes it to existing exporters. Contract fixtures and validators provide the
boundary evidence without coupling the infrastructure repository to producer
source code.

Use a matrix for each producer and signal:

```text
expected semantics -> emitted local payload -> accepted collector path
                   -> separately authorized live query
```

Unknown or stale evidence remains unknown. Dashboards and alerts must not
convert absence into a healthy zero.

## 7. Alternatives considered

### Uniform signal schema

- Pros: identical dashboard queries across services.
- Cons: forces Python, TypeScript, and Rust SDKs into one naming scheme and
  delays independent implementation.
- Decision: rejected; normalize meaning and record native/backend mappings.

### Descriptive inventory without a semantic floor

- Pros: fastest documentation.
- Cons: permits signals that exist but cannot answer traffic, latency, outcome,
  freshness, or correlation questions.
- Decision: rejected; the contract is advisory but still states a minimum goal.

### Multiple small infrastructure PRs

- Pros: easier human review and earlier contract visibility.
- Cons: additional branch, review, and coordination overhead under the current
  time constraint.
- Decision: rejected by the user for this issue; use one infrastructure PR and
  keep its commits organized by contract, wiring, and offline evidence.

### Implement infrastructure before observed payloads

- Pros: starts collector work immediately.
- Cons: risks guessed names, units, filters, and false-green tests.
- Decision: rejected; documentation can proceed, production wiring waits for
  producer evidence.

## 8. API and interface changes

- New advisory documentation interface:
  `docs/observability/service-signal-contract.md`.
- Reservation MCP receives the same OTEL environment contract as the other
  producers, using its own loopback endpoint.
- Collector configuration gains a reservation-MCP receiver and dedicated
  application metrics pipelines; trace receiver lists include all five inputs.
- Evidence tooling gains a five-producer signal matrix/report shape.

No HTTP, GraphQL, MCP tool, or business response contract changes.

## 9. Data model and persistence changes

None. Telemetry remains operational evidence with existing backend retention.
No database migration or backfill is required.

## 10. Security, privacy, and abuse considerations

- Bind every OTLP receiver to loopback; expose no telemetry port publicly.
- Keep metric attributes finite and allowlisted. Never label metrics with tenant,
  user, request, trace, prompt, raw URL, arbitrary fault, or exception values.
- Permit validated tenant and sanitized AWS correlation IDs only in logs/spans,
  on a best-effort basis.
- Use synthetic local/live evidence and exclude credentials, tokens, request
  bodies, personal data, account IDs, private resource identifiers, and raw
  validation output from committed artifacts.
- Preserve current least-privilege exporter IAM and endpoint policy boundaries;
  add permissions only if a verified route requires them.

## 11. Performance, scalability, and reliability considerations

- Preserve bounded collector memory, queues, retry elapsed time, and exporter
  timeouts so an outage cannot grow memory without limit.
- Keep application request handling independent from export success.
- Make drops, exporter failures, queue pressure, and collector CPU/memory visible
  where supported.
- Keep task-level CPU/memory distinct from per-container metrics because all
  applications share one Fargate task.
- Treat `tenant.id` metric labeling as a later cardinality/cost decision.
- Record trace loss during collector/Tempo outages as an expected ephemeral-data
  limitation, not successful delivery.

## 12. Implementation steps

1. Complete producer-owned instrumentation and evidence.
   - Change: implement the linked service issues and capture representative local
     exporter payloads for success, client/business failure, server/dependency
     failure, latency, propagation, and shutdown/outage behavior.
   - Repositories: reservation agent #20, reservation MCP #6, recommendation MCP
     #6, recommendation service #2, reservation service #42.
   - Notes: preserve public behavior; do not publish or deploy as part of this
     infrastructure task.
   - Verification: each producer's focused in-memory/exporter tests and normal
     repository checks pass.

2. Reconcile the advisory matrix with observed evidence.
   - Change: replace provisional signal rows with exact native names, types,
     units, temporalities, attributes, cadence, AMP translation, and zero/idle/
     stale semantics.
   - Files: `docs/observability/service-signal-contract.md` and contract fixtures
     under the existing test/fixture conventions if needed.
   - Verification: every implemented signal has an emitted-stage evidence row;
     discrepancies are documented rather than hidden by renaming.

3. Add reservation-MCP task-local transport.
   - Change: inject canonical OTEL identity/export configuration and a unique
     loopback endpoint; add collector readiness dependency consistent with the
     other instrumented applications.
   - Files: `lib/infra-stack.ts`, `test/infra.test.ts`.
   - Verification: CDK assertions prove exact environment, unique port, private
     receiver path, dependency behavior, and unchanged public exposure/IAM.

4. Route all five producers through the collector.
   - Change: add the reservation-MCP receiver, per-backend identity processors,
     AMP/CloudWatch metric pipelines, X-Ray routing, and optional Tempo routing.
     Audit all receiver lists and include/drop filters against observed payloads.
   - Files: `adot-collector/adot-config.yaml`,
     `adot-collector/tempo-overlay.yaml`, `scripts/validate-adot-image.sh`,
     `test/private-tempo.test.ts`.
   - Verification: collector startup/health validation and focused config tests
     cover five unique inputs and preserve the disabled/enabled Tempo paths.

5. Verify collector degradation behavior.
   - Change: assert bounded retry/queue/memory behavior and expose available
     export failure, drop, and resource-pressure evidence without changing
     application availability semantics.
   - Files: collector configuration, its validation script/tests, and relevant
     operational documentation.
   - Verification: offline failure fixtures or container smoke prove bounded
     behavior; no live fault injection is implied.

6. Add the offline cross-service evidence contract.
   - Change: pin every producer PR and merge commit, record the exact native
     metric shapes and CloudWatch dimensions, and assert all five receiver and
     pipeline paths without claiming live backend queryability.
   - Files: `test/fixtures/five-backend-signal-contract.json`,
     `test/collector-signal-contract.test.ts`, and the focused test command in
     `package.json`.
   - Verification: the contract test covers all 21 observed metric families,
     rejects duplicate selectors or receiver ports, and records Queryable as
     pending live acceptance.

7. Validate the combined infrastructure change.
   - Change: run the narrow checks during implementation and the repository CI
     equivalent before review.
   - Files: no additional files implied.
   - Verification: `npm run build`, focused Jest tests,
     `npm run validate:adot-image`, `npm run validate:xray-smoke`,
     `npm run validate:managed-metrics-smoke`, relevant Tempo/dashboard checks,
     `npm run synth:ecr-contract`, and `npm run ci` pass as applicable.

8. Open one organized infrastructure PR.
   - Change: present contract, producer evidence mappings, CDK/collector wiring,
     resilience, and offline evidence in reviewable commits within one PR.
   - Files: all issue-57 files above.
   - Verification: PR description maps each acceptance criterion to a test or
     explicitly deferred live check.

## 13. Testing strategy

- Producer unit/in-memory exporter tests establish emitted semantics.
- Collector container/config validation exercises real configuration parsing and
  representative payload acceptance.
- Jest/CDK assertions verify five unique private receiver paths, environment,
  dependencies, IAM/network invariants, and optional Tempo behavior.
- Shell/TypeScript smoke self-tests validate parsing, evidence states, failures,
  and absence of credential requirements.
- Offline digest-pinned synth proves the application artifact boundary remains
  intact and requires no AWS lookup.
- Separately authorized live acceptance verifies AMP, CloudWatch, X-Ray, Tempo,
  structured logs, joined traces, and honest saturation scope.

## 14. Rollout and migration plan

The source changes use one infrastructure PR, but artifacts remain independently
built and published by their owning repositories. Do not rebuild application
source from this repository.

The infrastructure expansion is designed to tolerate old producers that emit no
new signals. Under the user-selected time constraint, use one coordinated
runtime rollout:

1. publish reviewed producer images independently;
2. merge the combined infra PR after all emitted/accepted evidence is complete;
3. prepare one reviewed environment composition containing the compatible infra
   revision and all five exact producer digests;
4. review the complete CDK diff and one rollback composition before deployment;
5. deploy the infrastructure and producer set together in one task rollout;
6. run bounded smoke/query checks and record the actual active versions;
7. proceed to issue #58 dashboard/alert work after names are queryable.

Deployment, promotion, fault injection, and live acceptance require separate
authorization. Roll back by selecting the prior immutable producer/collector
composition as one unit and record any ephemeral trace loss. A desired-state
revert is not complete until the observed task composition and telemetry paths
are verified. This rollout minimizes operator time and task replacements, but a
failed acceptance check cannot isolate a producer through deployment order; use
the pre-release evidence matrix and per-service logs/traces to diagnose it.

## 15. Risks and mitigations

| Risk | Impact | Likelihood | Mitigation |
| --- | ---: | ---: | --- |
| Guessed SDK names or units | High | Medium | Wait for captured local payloads; keep native and AMP mappings separate. |
| One combined infra PR becomes difficult to review | High | High | Keep commits and PR sections aligned to contract, wiring, resilience, and smoke evidence; avoid issue #58 scope. |
| Collector filters silently discard valid signals | High | Medium | Test representative payloads through real config and audit every include/drop rule. |
| Missing telemetry appears healthy | High | Medium | Encode active/idle/stale semantics and require freshness/denominator guards. |
| High-cardinality or sensitive attributes reach metrics | High | Medium | Per-signal allowlists plus negative fixture assertions. |
| Partial producer availability delays the whole infra PR | Medium | High | Let sibling work proceed independently; track emitted evidence per row and begin production wiring only when all required rows exist. |
| Telemetry outage harms application traffic | High | Low | Preserve bounded export and runtime fail-open collector lifecycle. |
| Coordinated runtime promotion obscures which component caused a failure | High | Medium | Require complete emitted/accepted evidence before release, preserve one exact prior composition, and correlate the failed flow by service logs/traces before deciding whether to roll back the whole set. |

## 16. Done criteria

- Advisory contract reflects observed outputs for all five producers.
- All five producers have unique private OTLP inputs and correct exporter routes.
- Native names, units, attributes, freshness semantics, and the bounded AMP
  projection behavior are recorded without guessing backend-translated names or
  forcing a universal rename.
- Offline tests prove routing, filters, Tempo toggle, IAM/network invariants,
  bounded degradation, and credential-free smoke behavior.
- Per-container and shared-task saturation evidence is clearly distinguished.
- One infrastructure PR maps every issue acceptance item to offline evidence or a
  separately authorized live step.
- Live acceptance and issue #58 remain explicitly gated after the code PR.

### Offline implementation evidence

Producer evidence is pinned in
`test/fixtures/five-backend-signal-contract.json` to the five merged PRs and
their merge commits. The fixture records 21 native metric families with their
types, units, complete emitted attribute sets, and intended bounded CloudWatch
dimensions. The collector contract test proves exact five-receiver membership
for CloudWatch, AMP, X-Ray, and optional Tempo and leaves **Queryable** pending.

On 2026-09-18, `npm run ci` passed the complete repository check, including:

- TypeScript and automation builds/tests;
- 33 workload/Tempo/collector contract tests;
- the real pinned ADOT image startup and health validation;
- X-Ray, managed-metrics, integrated-demo, Grafana, and audit-router validators;
- offline digest-pinned workload, foundation, OIDC, audit, and observability
  synth contracts.

No live backend query, deployment, artifact publication, environment mutation,
or dashboard/alert work is claimed by this evidence.

## 17. Review checklist

- [x] Requirements and non-goals are explicit.
- [x] Existing CDK, collector, smoke, and documentation conventions were checked.
- [x] Contract ownership and sibling-repository boundaries are explicit.
- [x] Alternatives and the user-selected one-PR tradeoff are recorded.
- [x] Security, cardinality, privacy, reliability, and failure behavior are covered.
- [x] Testing, runtime rollout, and rollback evidence are separated.
- [x] Implementation steps name expected files and verification.
- [x] Observed producer payloads have replaced provisional mappings.
- [x] Runtime promotion shape has been confirmed with the user.

## 18. Handoff prompt for implementation agent

```text
Implement docs/plans/five-backend-telemetry-wiring.md only after all five producer
issues have supplied the emitted-stage payload evidence required by
docs/observability/service-signal-contract.md.

Constraints:
- Deliver issue #57 as one organized infrastructure PR.
- Do not implement issue #58 dashboards or alerts.
- Do not invent or normalize away unverified metric names, units, or labels.
- Preserve existing HTTP/GraphQL/MCP behavior, private-only OTLP receivers,
  bounded exporter behavior, X-Ray routing, and the optional Tempo toggle.
- Do not introduce new dependencies unless the plan is updated and reviewed.
- Do not publish artifacts, mutate environment composition, deploy, inject live
  faults, or run live acceptance without separate authorization.
- If producer evidence contradicts the advisory contract, update the contract and
  plan before changing production wiring.

Relevant files:
- docs/observability/service-signal-contract.md
- lib/infra-stack.ts
- adot-collector/adot-config.yaml
- adot-collector/tempo-overlay.yaml
- scripts/validate-adot-image.sh
- scripts/integrated-demo-smoke.sh
- scripts/managed-metrics-smoke.sh
- scripts/xray-smoke.sh
- test/infra.test.ts
- test/private-tempo.test.ts
- focused smoke-tool tests and operations docs

Expected verification:
- npm run build
- focused Jest tests while iterating
- npm run validate:adot-image
- npm run validate:xray-smoke
- npm run validate:managed-metrics-smoke
- relevant Tempo/dashboard validators
- npm run synth:ecr-contract
- npm run ci
```
