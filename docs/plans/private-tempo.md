# Implementation plan: optional private Tempo (#54)

## Summary and goals

Add native tracing to the service demo without replacing AMP, X-Ray, audit
routing or the six-image release contract. A separate private Fargate monolith
is sufficient for a short, low-traffic rehearsal. Disabled is the default.

## Current state and assumptions

`lib/infra-stack.ts` owns the disposable VPC, single application task and AWS
endpoints. `ObservabilityStack` owns retained Grafana/AMP and the workload imports
their outputs. An opposite CloudFormation import would form a cycle. AMG routes
all data-source traffic through a configured outbound VPC connection, so its
AWS query paths must be made reachable before attachment.

## Design and alternatives

Use a repository-owned immutable Tempo 2.10.8 image asset, separate 0.5 vCPU /
1 GiB task, Cloud Map private DNS, local ephemeral trace storage and 24-hour
retention. Data is lost when the Tempo task is replaced; this is not an audit
store. Keep application ADOT export to X-Ray and add a bounded OTLP queue only
when enabled. No new application instrumentation is required.

Rejected: public unauthenticated Tempo; a new HA telemetry stack; replacing AMP;
and adding Tempo inside the application task (couples their failure lifecycles).
Persistent S3 traces and authenticated TLS proxying remain follow-ups before
production use. Private trusted VPC HTTP is explicitly a disposable-demo choice.

## Contracts and implementation

1. `enableTempo` validated boolean context and `demo:workload --enable-tempo`.
2. `lib/private-tempo.ts`: separate task/service, DNS, ingress from app on 4317
   and AMG on 3200 only; explicit `TempoTaskDefinition`/`TempoService` logical IDs.
3. Workload outputs: `TempoQueryUrl`, `TempoOtlpEndpoint`, `GrafanaVpcId`,
   `GrafanaVpcSubnetIds` (CSV of two private AZ subnets), `GrafanaVpcSecurityGroupId`.
4. Additional monitoring, EC2 and AMP control-plane endpoints; existing
   endpoint query policies for AMP/X-Ray/STS. IAM remains independently enforced.
5. `adot-collector/tempo-overlay.yaml`: additive pipeline with bounded retries.
6. Operator explicitly attaches AMG using concrete output IDs and snapshots the
   previous configuration. Environments tooling refuses teardown while attached.
   This acknowledged temporary drift is not hidden inside a deployment hook.

## Security, reliability and cost

No public IP, public trace ports, NAT, app role broadening or secrets. Endpoint
security group permits the AMG connection and Tempo to reach AWS HTTPS. Tempo
needs image pulls/logging only; its task role has no application permissions.
One task and extra interface endpoints incur charges until workload teardown.
The single-AZ runtime is not highly available; DNS TTL and bounded ADOT retries
can lose traces during restart. Demo traffic only; trace payloads may contain
personal data, so fixtures must remain synthetic.

## Verification and rollout

Build, focused CDK/tooling tests, default synth compatibility, and Docker config
startup/smoke tests. Assert separate task, private-only edges, no NAT, two AMG
subnets, bounded optional pipeline and baseline default preservation.
Deploy requires separate account preflight, diff review and approval. Attach
only after readiness; verify AMP, X-Ray, CloudWatch logs/metrics and Tempo from
AMG. Live checks are not implied by offline passing tests.

## Rollback and done criteria

Restore AMG outbound settings first, verify detach, then disable Tempo/redeploy
or destroy workload. Keep foundations. Never delete VPC while AMG is attached.
Done for PR: tests and documented contracts; done for rehearsal: one real trace
queried in AMG plus regression tests and independent teardown verification.

## References and review

- https://docs.aws.amazon.com/grafana/latest/userguide/AMG-configure-vpc.html
- https://github.com/grafana/tempo/tree/v2.10.8/example/docker-compose/local
- Local KB: `concepts/AWS VPC Endpoints.md` (private paths, not general egress).

Requirements, scope, alternatives, security, lifecycle and offline/live evidence
are explicit. User authorization covers implementation/PR, not cloud changes.

## Implementation evidence

The pinned image starts non-root and passes `/ready`. A synthetic trace through
the real ADOT overlay was retrieved from Tempo in a network-isolated Docker
smoke test; the same check runs in PR CI. On 2026-09-16 a local vulnerability scan
with platform-pinned Trivy 0.70.0 and a fresh database reported **0 CRITICAL and
12 HIGH** findings in the Tempo binary, without ignoring unfixed findings or
applying exemptions. This is not a clean-vulnerability claim or live acceptance.
