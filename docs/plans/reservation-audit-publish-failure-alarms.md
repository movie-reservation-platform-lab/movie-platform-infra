# Implementation Plan: Reservation Audit Publish Failure Alarms

Tracking: #88, a producer-side implementation slice of #78. Planning and
synthesis are authorized; deployment and provider subscription are not.

## 1. Summary

Reconcile the reservation service's merged audit publish metrics into the
five-backend signal contract, project bounded CloudWatch series, and add native
CloudWatch alarms for primary publisher failures and unaudited successful
logins. The primary publish-latency warning is deferred; see section 6. Keep alarm
thresholds and a provider-neutral SNS action in `MovieReservationWorkloadStack`,
outside the reusable `AuditIngestion` construct.

The CloudWatch projection deliberately omits `audit_publisher`: alarms follow the
semantic `primary` role across an EventBridge-to-stdout rollback. AMP continues
to receive every native attribute for comparison and transport investigation.

## 2. Goals

- Record service PR #52's merged metric evidence and exact merge commit.
- Preserve actionable, bounded role and failure-reason dimensions in CloudWatch.
- Detect every primary audit publish failure, including telemetry-pipeline loss.
- Detect the specific fail-open case of an authenticated login without an
  accepted audit event.
- ~~Warn when primary publish p99 reaches 80% of the configured publish timeout.~~
  Deferred during implementation; see "Percentile export finding" in section 6.
- Route alarm transitions to one composition-owned, unsubscribed SNS topic.
- Prove the CloudFormation contracts with focused CDK assertions and offline
  synth only.
- Keep the workload-side detection needed to demonstrate an application in the
  development workload account with audit delivery and observability visible
  across the intended account boundaries.

### End-to-end demo mission

The immediate platform mission is to deploy the application into the dedicated
development workload account and present the user journey, centralized audit
records, and operational telemetry end to end. In that topology:

- `MovieReservationWorkloadStack` and its critical audit-gap alarms belong to
  the development workload account;
- accepted audit events cross into the dedicated audit account;
- logs, metrics, and traces are collected at the workload source and may be
  viewed there initially; and
- a future dedicated observability account may provide the central view without
  moving critical audit-gap detection away from the workload account.

`movie-platform-environments` owns private logical-target resolution and the
guided prepare/diff/deploy/verify/teardown workflow. This public repository owns
the explicit workload inputs, synthesized resources, and reusable account-role
contract. It must not contain concrete account IDs, local profile or role names,
private ARNs, or claims about live environment state.

Issue #88 supplies a required detection slice for that demo. It does not by
itself make the multi-account deployment path executable.

## 3. Non-goals

- Changing authentication fail-open behavior, publisher retries, timeout bounds,
  or the service environment-variable contract.
- Building the outbox tracked by #76 or auditing GraphQL successes tracked by
  movie-reservation-service#50.
- Choosing or subscribing incident.io, PagerDuty, email, or another receiver.
- Adding central EventBridge, Firehose, DLQ, Grafana, or synthetic-verification
  work from the remaining parent #78 scope.
- Adding alarms to `@movie-platform/audit-ingestion` or deploying AWS resources.
- Reopening the EventBridge comparison decision gate.
- Implementing private environment-target selection, cross-account observability
  links, or the guided multi-account demo workflow.

## 4. Current State

- `lib/infra-stack.ts` composes the ECS workload, imports the reservation-service
  log group, supplies `AUDIT_PUBLISH_TIMEOUT_MS`, and supplies the shared
  `MoviePlatform/<environment>/applications` CloudWatch namespace to ADOT.
- `lib/config/platform-config.ts` validates the publish timeout to 100--5000 ms;
  its default is 1000 ms. The alarm threshold can therefore be derived from the
  same validated value used by the service.
- `adot-collector/adot-config.yaml` sends reservation-service metrics to AMP and
  the AWSEMF exporter. CloudWatch declarations currently cover 21 metric
  families and use `NoDimensionRollup`.
- `test/fixtures/five-backend-signal-contract.json` and
  `test/collector-signal-contract.test.ts` bind native metric evidence to exact
  CloudWatch declarations. Service PR #52 merged as
  `3fae4d186b45556e7d1c9c7530997e21a071b555`.
- `docs/observability/service-signal-contract.md` still lists
  `audit_publish_total` and `audit_publish_duration_ms` as pending evidence.
- The service initializes seven counter series for each configured
  publisher/role pair: one accepted/`none` series and six failed series for
  `timeout`, `aborted`, `rejected`, `throttled`, `configuration`, and
  `unavailable`. It does not synthesize histogram points.
- The service's structured logger emits top-level `event`, `auth_status_id`, and
  bounded `failure_reason` fields. `auth_status_id=1` is an authenticated login.
- The repository has no SNS alarm-routing boundary. The existing router rejection
  alarm in `lib/observability-stack.ts` demonstrates the Logs metric-filter
  pattern but has no alarm action.

## 5. Requirements and Assumptions

### Confirmed Requirements

- Alarm on `primary` + `failed` counter increments separately by bounded failure
  reason and use a strict greater-than-zero comparison.
- Treat a missing counter datapoint as breaching. Startup-created zero series
  make absence a telemetry-path failure rather than a healthy zero.
- Match `audit.emit.failed` and numeric `auth_status_id=1` together.
- ~~Alarm on p99 publish duration approaching the configured timeout.~~ Deferred.
- Keep thresholds and alarm actions in workload composition.
- Make no AWS mutations.

### Assumptions

- (Deferred warning) “Approaching” means 80% of `auditPublisher.timeoutMs`:
  800 ms under the current default.
- One 60-second breaching period is appropriate for primary failure and
  unaudited-success alarms because a single audit gap is actionable.
- Missing log-filter points are non-breaching because no matching
  successful-login failure and no login traffic are normal. Counter alarms are
  the independent telemetry-liveness guard.
- Only `ALARM` transitions publish to SNS in this slice. Recovery and
  insufficient-data routing remain future incident-policy decisions.

### Open Questions

None for this slice. The engineer accepted the hybrid ownership card in section
12. Any change to the account topology or the engineer-owned code boundary must
be recorded before implementation proceeds.

## 6. Proposed Design

### Evidence and CloudWatch dimensions

Add both metric families to the reservation-service fixture entry and move the
PR #52 row into reconciled evidence. Use these CloudWatch dimension sets:

| Metric | CloudWatch dimensions | Reason and bounded cost |
| --- | --- | --- |
| `audit_publish_total` | `ServiceName`, `Environment`, `audit_publisher_role`, `result`, `failure_reason` | `audit_publisher_role` has two values and separates critical primary failure from best-effort comparison failure. `failure_reason` has six failed values plus accepted `none`; it costs five additional failed streams per role compared with one aggregate failure stream, but directly selects the response playbook. `result` is required to separate accepted from failed attempts. |
| `audit_publish_duration_ms` | `ServiceName`, `Environment`, `audit_publisher_role` | Role keeps primary latency separate from comparison overhead. Omitting result produces one useful latency distribution per role and avoids splitting a sparse distribution. |

Omit `audit_publisher` from both CloudWatch shapes. It is bounded, but including
it would couple alarms to the active transport and split series while old and new
tasks overlap during rollback. The native attribute remains queryable in AMP.
With the current primary-plus-comparison composition, the counter materializes
at most 14 known streams (seven per role) and duration materializes two streams.

### Percentile export finding (latency warning deferred)

The original design added a second AWSEMF exporter with `detailed_metrics: true`
so CloudWatch could compute p99. Implementation found that the `awsemf` exporter
publishes explicit-bucket histograms, which the service's JS SDK uses by default,
only as Count/Sum/Min/Max statistic sets regardless of `detailed_metrics`. Only
exponential histograms receive Values/Counts. Histograms are also not converted
to deltas, so every CloudWatch histogram statistic in this repository describes
the process lifetime rather than one period.

A per-period p99 therefore needs a service change (exponential aggregation for
`audit_publish_duration_ms`) plus collector-side `cumulativetodelta` and a
detailed exporter. The engineer chose to defer the latency warning rather than
broaden this slice. `audit_publish_duration_ms` is still projected on the
existing exporter for consistency with the other latency families; timeouts
remain covered by the `failure_reason=timeout` alarm. Follow-up work: the
deferred latency warning and the cumulative-histogram projection for all
existing latency families.

### Alarms and routing

Create an unsubscribed SNS topic in `MovieReservationWorkloadStack` and attach a
CDK `SnsAction` to every alarm.

Create six counter alarms over the shared application namespace, one per failure
reason. Each selects reservation service + environment + primary + failed + one
reason, uses `Sum`, 60 seconds, threshold 0,
`GREATER_THAN_THRESHOLD`, one evaluation period, and `BREACHING` missing data.

Create a Logs metric filter on the imported reservation-service log group with
the exact JSON conjunction `event = "audit.emit.failed"` and
`auth_status_id = 1`. Its `Sum` alarm uses a 60-second period, strict
greater-than-zero comparison, one evaluation period, and `NOT_BREACHING` missing
data.

The p99 latency alarm is deferred; see the percentile export finding above.

The resulting CDK code synthesizes `AWS::CloudWatch::Alarm`,
`AWS::Logs::MetricFilter`, `AWS::SNS::Topic`, and topic-policy resources. It does
not create or change any live resource until a separately approved deployment.

## 7. Alternatives Considered

### Global detailed metrics on the existing exporter

- Pros: one exporter and minimal collector-test changes.
- Cons: expands EMF payloads for every existing application histogram, outside
  this slice's need.
- Decision: Reject; superseded by the percentile export finding in section 6.

### Alarm from AMP or Grafana

- Pros: native OTel histogram quantiles and shared dashboard query language.
- Cons: makes Grafana/AMP evaluation part of the critical detection path and does
  not satisfy the native CloudWatch alarm requirement.
- Decision: Reject for detection; AMP remains an investigation backend.

### Include `audit_publisher` as a CloudWatch dimension

- Pros: CloudWatch alone identifies the transport.
- Cons: splits sparse series and makes alarm selectors depend on a transport that
  is intentionally changed by the one-variable rollback.
- Decision: Reject; alert by semantic role and investigate transport in AMP/logs.

### One aggregate failure alarm

- Pros: fewer alarms and simpler synthesis.
- Cons: loses the requested per-reason state and delays the correct response for
  timeout, throttling, configuration, and availability failures.
- Decision: Reject; the six-value reason set is bounded and operationally useful.

## 8. API / Interface Changes

- No application API or environment-variable changes.
- The collector adds one internal AWSEMF exporter and changes only the
  reservation-service CloudWatch pipeline exporter list.
- The workload stack gains a CloudFormation output for the provider-neutral audit
  alarm topic ARN so a later approved integration can subscribe without finding
  a generated physical name.

## 9. Data Model / Persistence Changes

None. CloudWatch custom metric streams, alarms, a metric filter, and an empty SNS
topic are disposable infrastructure resources.

## 10. Security, Privacy, and Abuse Considerations

- The metric filter matches stable event/status fields and emits only a count. It
  does not copy correlation IDs, actor identifiers, exceptions, or audit payloads
  into metric dimensions.
- No SNS subscription, endpoint, credential, or secret is created.
- Alarm dimensions remain bounded; request IDs and other untrusted values are
  excluded to prevent cost amplification.
- The existing task IAM is unchanged. CDK's SNS alarm action adds only the topic
  resource policy required for CloudWatch alarm publication.

## 11. Performance, Scalability, and Reliability Considerations

- Six reason alarms intentionally trade a small fixed alarm count for immediate
  failure classification. No dynamic alarm-per-value mechanism is introduced.
- `BREACHING` missing data on the continuously preinitialized counter catches a
  broken producer/collector/EMF path. Deployment overlap can transiently combine
  cumulative series but does not change the strict any-failure policy.
- The log alarm provides a second signal for the highest-impact fail-open case;
  it is not used as a replacement audit record.
- An unsubscribed topic preserves detection and a stable integration boundary,
  but no human receives a notification until a later approved subscription is
  configured. The alarm states remain visible in CloudWatch meanwhile.

## 12. Implementation Steps and Ownership Card

Learning target: connect a structured CloudWatch Logs filter to a metric alarm
and explain the synthesized resources.

AI owns: issue and plan scaffolding; evidence/collector changes; dimension and
cost documentation; six counter alarms; SNS action boundary;
surrounding tests and verification.

Engineer owns: the `audit.emit.failed` + `auth_status_id=1` metric filter and its
alarm in `lib/audit-gap-alarms.ts`, plus focused assertions in `test/infra.test.ts`.

Done evidence: assertions prove the exact JSON conjunction, namespace/name,
threshold, comparison, period, missing-data policy, and SNS alarm action.

Support level: guided.

1. Reconcile producer evidence and collector projection. **AI-owned**
   - Change: add the two metric families and PR #52 commit to the fixture; move
     the documentation row to reconciled evidence; document dimensions/cost.
   - Files: `test/fixtures/five-backend-signal-contract.json`,
     `docs/observability/service-signal-contract.md`.
   - Verification: collector contract test sees 23 native families and exact
     declarations.

2. ~~Preserve percentile data only for audit duration.~~ **Deferred**
   - Change: none in this slice; both families use the existing exporter.
   - Files: `adot-collector/adot-config.yaml`, `scripts/validate-adot-image.sh`.
   - Verification: the pinned collector accepts 23 declared selectors.

3. Compose alarm routing and metric alarms. **AI-owned**
   - Change: create the SNS topic/action, six reason alarms, and topic ARN
     output in workload composition.
   - Files: `lib/infra-stack.ts`, `test/infra.test.ts`.
   - Verification: CDK assertions inspect dimensions, threshold, missing-data
     policy, and `AlarmActions`.

4. Add the unaudited-success log alarm. **Engineer-owned**
   - Change: add one JSON metric filter and alarm to workload composition and the
     focused assertions described in the ownership card.
   - Files: `lib/audit-gap-alarms.ts`, `test/infra.test.ts`.
   - Verification: `npx jest --runInBand --runTestsByPath test/infra.test.ts`.

5. Document operator meaning and verify the slice. **AI-owned**
   - Change: document severity, missing-data meaning, topic boundary, and the
     first response for each failure reason, and the deferred latency warning.
   - Files: likely `docs/operations/audit-publish-alarms.md` and operations index.
   - Verification: inspect documentation diff, run focused/full offline checks,
     and synthesize without lookups.

### Implementation decisions (2026-10-09)

- The topic and alarms live in a local `AuditGapAlarms` construct
  (`lib/audit-gap-alarms.ts`) instantiated by workload composition, following
  the `PrivateTempo` precedent, so the workload stack does not grow further.
- The six reason alarms have no actions; one composite alarm (any child in
  `ALARM`) is the single notifier, so one outage sends one notification while
  the children still name the reason. Incident grouping and deduplication
  beyond that remain the future incident tool's job. The unaudited-success
  alarm notifies separately because it is the higher-severity signal.
- The successful-login signal is log-derived for now. Follow-up
  ([movie-reservation-service#54](https://github.com/movie-reservation-platform-lab/movie-reservation-service/issues/54)): the service
  emits the login outcome as a bounded OTel attribute, after which the log
  metric filter can be replaced or kept as an independent path.

- Ownership change: the engineer wrote the metric filter and the first alarm
  draft; at the engineer's request the AI completed the alarm (compile fix and
  description) and the focused assertions.

## 13. Testing Strategy

- Update the collector contract test from 21 to 23 evidenced families and
  validate per-metric producer evidence.
- Add focused CDK assertions for exactly six reason alarms, exact dimension maps,
  strict comparison, 60-second periods, one evaluation period, breaching missing
  data, and SNS actions.
- Assert the log filter's exact JSON conjunction and its alarm contract.
- Run `npm run build:root`, the two focused Jest files,
  `npm run validate:adot-image`, `npm run synth:ecr-contract`, and
  `git diff --check`. Broaden to `npm run ci` only if focused results or changed
  shared contracts justify it before handoff.

## 14. Rollout / Migration Plan

This slice stops at offline synthesis. A later deployment must review `cdk diff`,
confirm the expected seven alarms, one metric filter, one topic and topic policy,
then verify zero counter datapoints before treating the
alarms as operational. Provider subscription requires separate approval.

Rollback is a stack-code revert. The service's `AUDIT_PUBLISHER=stdout` rollback
continues to match these role-based alarm dimensions without changing alarm code.
Deleting the topic or alarms must occur only through an approved stack update or
destroy workflow.

The later development demo acceptance must also prove, through the private
environment workflow, that the application runs in the selected workload
account, an authenticated success reaches the dedicated audit path, telemetry is
queryable from the selected observability view, and workload teardown preserves
the audit and observability foundations. Those live checks are cross-repository
acceptance work and remain outside issue #88's synth-only authorization.

## 15. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
| --- | ---: | ---: | --- |
| Statistic-set export makes p99 unavailable | Medium | Certain | Latency warning deferred; timeouts still alarm through `failure_reason=timeout`. |
| Counter telemetry stops and looks healthy | High | Low/Medium | Treat missing preinitialized primary failure series as breaching. |
| Rollback changes publisher and invalidates selectors | High | Medium | Omit publisher from CloudWatch dimensions; select `primary` role. |
| Comparison failures page as production audit gaps | Medium | Medium | Retain role and alarm only on `primary`. |
| High-cardinality custom metrics increase cost | High | Low | Only bounded role/result/reason dimensions; no identifiers or exception text. |
| Topic exists but reaches no operator | High | Certain until follow-up | State this limit explicitly; expose topic ARN for a separately approved provider subscription. |

## 16. Done Criteria

- The merged PR #52 evidence and both metrics are reconciled in fixture/docs.
- CloudWatch projection has the documented bounded dimensions and 23 unique
  family selectors.
- Six primary failure alarms and one unaudited-success alarm synthesize with
  explicit missing-data behavior and SNS actions.
- Alarm policy remains in workload composition and `AuditIngestion` is unchanged.
- Operator documentation explains severity, response, missing data, and the
  unsubscribed routing boundary.
- Build, focused tests, pinned-image config validation, offline synth, and diff
  checks pass.
- Engineer-owned code is reviewed, integrated, and explained before completion.
- The synthesized alarms remain account-local to the workload and require no
  private target identifiers in this repository.

## 17. Review Checklist

- [x] Requirements and non-goals are explicit.
- [x] Existing composition, collector, evidence, and test conventions were checked.
- [x] Dimension cost and rollback behavior were considered.
- [x] Security, privacy, reliability, and low-sample behavior were reviewed.
- [x] Alternatives and percentile export constraints were considered.
- [x] Tests, rollout, rollback, and live limitations are explicit.
- [x] Hybrid ownership card is accepted by the engineer.

## 18. Handoff Prompt for Implementation Agent

```text
Implement docs/plans/reservation-audit-publish-failure-alarms.md for issue #88.

Constraints:
- Preserve the agreed hybrid ownership split; stop before the engineer-owned
  log metric filter/alarm and its focused assertions.
- Do not deploy, subscribe the SNS topic, or mutate AWS resources.
- Keep alarm thresholds/actions in MovieReservationWorkloadStack and do not
  modify the reusable AuditIngestion construct.
- Do not add dependencies or change the service environment contract.
- Preserve the EventBridge comparison decision gate and stdout rollback semantics.
- Update tests/docs named in the plan. If the pinned collector contradicts the
  detailed-export design, stop and revise the plan before broadening scope.

Relevant files:
- adot-collector/adot-config.yaml
- lib/infra-stack.ts
- test/fixtures/five-backend-signal-contract.json
- test/collector-signal-contract.test.ts
- test/infra.test.ts
- docs/observability/service-signal-contract.md
- docs/operations/

Expected verification:
- npm run build:root
- npx jest --runInBand --runTestsByPath test/collector-signal-contract.test.ts test/infra.test.ts
- npm run validate:adot-image
- npm run synth:ecr-contract
- git diff --check
```
