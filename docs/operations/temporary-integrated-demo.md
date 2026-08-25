# Temporary Integrated AWS Demo Runbook

This is the controlling operator path for the deadline-oriented seven-container
AWS demo. It deploys six independently published application images plus the
repository-owned ADOT collector in one disposable Fargate task. Only the Nginx
web container is reachable through the prefix-list-restricted ALB.

This runbook does not grant standing permission to mutate AWS. Stop at every
**approval gate**, show the exact command or CDK diff to the operator, and wait
for explicit approval. Record only sanitized outcomes in
`.local/temporary-integrated-demo-journal.md`.

## Accepted Demo Limitations

- One task couples the deployment, scaling, health, and rollback of all six
  components. Issue #6 owns the later independently deployable topology.
- ECS health checks deliberately mirror the selected images' published runtime
  contracts: `wget /health` for web, `curl /health` for the agent and MCPs,
  `curl /ready` for recommendation service, and the distroless reservation
  service's `/nodejs/bin/node` plus `fetch(/ready)`. Changing a sibling base
  image, binary path, or health route can break this stack without changing this
  repository. Revert the environment release and infrastructure change together
  to the previous six-digest set; do not roll back one coupled container alone.
- The reservation MCP propagates `traceparent`, `tracestate`, correlation, and
  request IDs, but it does not currently create its own OpenTelemetry spans or
  structured telemetry. A trace may therefore jump from the agent to the
  reservation API even though reservation MCP participated in the request.
- The runnable non-root Nginx web image is a temporary ECS exception. The
  frontend's long-term artifact remains its non-runnable static-site OCI bundle
  for private S3 and CloudFront.
- The temporary web image was produced by the canonical workflow but did not
  receive the explicit GitHub provenance attached to the long-term static-site
  bundle. Treat it as a named manual-demo exception, not provenance-equivalent
  admission or the production frontend model.
- The internet-reachable web container shares the task-wide IAM role with ADOT.
  A compromised web process could therefore forge or spam X-Ray, AMP, and
  metrics-log telemetry even though it cannot deploy or mutate the workload.
  Treat demo telemetry as operational evidence, not tamper-resistant audit
  evidence. Issue #6 must separate edge and telemetry-writer identities in the
  independently deployable topology.
- Grafana Logs Insights and X-Ray read APIs require some `Resource: *` IAM
  permissions because those APIs do not support useful resource scoping. The
  role remains read-only. Keep log queries on a narrow time range because Logs
  Insights scans are billable.

## Gate 0: Merged Inputs And Offline Verification

Use clean `main` checkouts for the infra and private environments repositories.
The reviewed environment release must supply six exact GHCR source digests,
source revisions, workflow runs, `sourceVersion`, and `deploymentVersion`.
Map each component's `destinationImageReference` and `deploymentVersion` into
CDK context. `sourceVersion` remains provenance and is not the runtime version.
Tags are provenance hints only; the web deployment version uses its temporary
`ecs-demo-sha-...` hint.

```bash
npm ci
npm run ci
git diff --check
```

This gate is credential-free. It proves configuration parsing, synthesized
contracts, dashboard shape, and smoke-helper behavior. It cannot prove AWS
provisioning, registry contents, runtime health, or telemetry delivery.

Create the ignored journal before any live operation:

```bash
mkdir -p .local
touch .local/temporary-integrated-demo-journal.md
git check-ignore .local/temporary-integrated-demo-journal.md
```

Stop if the file is not ignored.

## Gate 1: Expand The Persistent Artifact Foundation

The foundation update creates five additional retained ECR repositories. This
is an AWS mutation boundary separate from workload deployment.

```bash
export AWS_PROFILE=movie-platform-demo
export AWS_REGION=eu-central-1
export AWS_ACCOUNT_ID='<12-digit-account-id>'

aws sso login --profile "$AWS_PROFILE"
npm run preflight:aws
```

**AWS-contact gate:** `cdk diff` can publish a template and create a temporary
read-only CloudFormation change set. Show the command and wait for explicit
approval before running it:

```bash
npm run cdk:foundation -- diff ArtifactFoundationStack
```

**Mutation approval gate:** verify that the diff changes only the expected
six-repository foundation and outputs. Wait for a separate explicit approval,
rerun the preflight, then:

```bash
npm run cdk:foundation -- deploy ArtifactFoundationStack
npm run cleanup:artifact-foundation
```

Record the sanitized deployment and inspection outcome. Preserve this stack
during routine demo teardown.

## Gate 2: Copy And Verify Exact Candidates

Reservation service must retain its successful generalized admission result.
For the other five demo candidates, use the reviewed temporary procedure owned
by environments issue #25. Each transfer request must use
`artifact-copy-request-v2`, `copy-and-verify`, the exact GHCR digest, the
matching trusted ECR repository, and separate short-lived Docker auth files:

```json
{
  "requestVersion": "artifact-copy-request-v2",
  "operation": "copy-and-verify",
  "sourceReference": "ghcr.io/movie-reservation-platform-lab/<component>@sha256:<64-hex-digest>",
  "destinationRepository": "<account>.dkr.ecr.eu-central-1.amazonaws.com/<component>",
  "expectedDigest": "sha256:<same-64-hex-digest>",
  "sourceAuthFile": "/private/temporary/ghcr-auth.json",
  "destinationAuthFile": "/private/temporary/ecr-auth.json"
}
```

For each of `movie-reservation-web`, `movie-reservation-agent`,
`movie-reservation-mcp`, `movie-recommendation-mcp`, and
`movie-recommendation-service`, first build and test the credential-free runtime:

```bash
npm run validate:artifact-copy
```

**Approval gate:** review all five exact source/destination/digest tuples and
the short-lived credential plan together. After explicit approval, run one
request at a time through the pinned Skopeo executable:

```bash
node automation/artifact-copy/dist/main.js \
  --request-file /private/temporary/<component>-copy-request.json \
  --skopeo-executable /absolute/path/to/pinned/skopeo
```

Stop on the first nonzero exit or digest mismatch. Do not use `latest`, rebuild
source, print auth files, or paste registry passwords into shell arguments.
Delete the request and auth files after the verified results are captured.

## Gate 3: Review The Workload Diff

Export the six verified private-ECR references and human release identifiers:

```bash
export ALLOWED_INGRESS_PREFIX_LIST_ID='pl-<reviewed-id>'
export APPLICATION_IMAGE_REFERENCE="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/movie-reservation-service@sha256:<digest>"
export APPLICATION_SERVICE_VERSION='<reservation-service deploymentVersion>'
export RESERVATION_WEB_IMAGE_REFERENCE="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/movie-reservation-web@sha256:<digest>"
export RESERVATION_WEB_SERVICE_VERSION='<reservation-web deploymentVersion>'
export RESERVATION_AGENT_IMAGE_REFERENCE="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/movie-reservation-agent@sha256:<digest>"
export RESERVATION_AGENT_SERVICE_VERSION='<reservation-agent deploymentVersion>'
export RESERVATION_MCP_IMAGE_REFERENCE="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/movie-reservation-mcp@sha256:<digest>"
export RESERVATION_MCP_SERVICE_VERSION='<reservation-mcp deploymentVersion>'
export RECOMMENDATION_MCP_IMAGE_REFERENCE="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/movie-recommendation-mcp@sha256:<digest>"
export RECOMMENDATION_MCP_SERVICE_VERSION='<recommendation-mcp deploymentVersion>'
export RECOMMENDATION_SERVICE_IMAGE_REFERENCE="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/movie-recommendation-service@sha256:<digest>"
export RECOMMENDATION_SERVICE_VERSION='<recommendation-service deploymentVersion>'

CDK_CONTEXT=(
  -c "allowedIngressPrefixListId=$ALLOWED_INGRESS_PREFIX_LIST_ID"
  -c "applicationImageReference=$APPLICATION_IMAGE_REFERENCE"
  -c "applicationServiceVersion=$APPLICATION_SERVICE_VERSION"
  -c "reservationWebImageReference=$RESERVATION_WEB_IMAGE_REFERENCE"
  -c "reservationWebServiceVersion=$RESERVATION_WEB_SERVICE_VERSION"
  -c "reservationAgentImageReference=$RESERVATION_AGENT_IMAGE_REFERENCE"
  -c "reservationAgentServiceVersion=$RESERVATION_AGENT_SERVICE_VERSION"
  -c "reservationMcpImageReference=$RESERVATION_MCP_IMAGE_REFERENCE"
  -c "reservationMcpServiceVersion=$RESERVATION_MCP_SERVICE_VERSION"
  -c "recommendationMcpImageReference=$RECOMMENDATION_MCP_IMAGE_REFERENCE"
  -c "recommendationMcpServiceVersion=$RECOMMENDATION_MCP_SERVICE_VERSION"
  -c "recommendationServiceImageReference=$RECOMMENDATION_SERVICE_IMAGE_REFERENCE"
  -c "recommendationServiceVersion=$RECOMMENDATION_SERVICE_VERSION"
)
```

Run the account and prefix-list preflights from the standard deployment runbook,
then synthesize offline:

```bash
npm run cdk -- synth MovieReservationWorkloadStack --no-lookups "${CDK_CONTEXT[@]}"
npm run preflight:aws
```

**AWS-contact gate:** `cdk diff` can publish the ADOT asset metadata/template
and create a temporary read-only CloudFormation change set. Wait for explicit
approval before running it:

```bash
npm run cdk -- diff MovieReservationWorkloadStack "${CDK_CONTEXT[@]}"
```

**Mutation approval gate:** review the complete diff, all six digests, task
size, frontend-only ALB target, Grafana read-only permissions, expected cost,
and teardown owner. Do not deploy from an unreviewed or dirty checkout.

## Gate 4: Deploy The Disposable Workload

After explicit approval, rerun the preflight immediately before deployment:

```bash
npm run preflight:aws
npm run cdk -- deploy MovieReservationWorkloadStack \
  --require-approval never \
  --outputs-file .local/integrated-demo-stack-outputs.json \
  "${CDK_CONTEXT[@]}"
```

The outputs file is local operational state and must remain ignored. Wait for
CloudFormation completion and healthy ECS/ALB state before continuing.

## Gate 5: Runtime And Telemetry Acceptance

Read the base URL from the output rather than reconstructing it:

```bash
export DEMO_BASE_URL="$(jq -r '.MovieReservationWorkloadStack.DemoBaseUrl' .local/integrated-demo-stack-outputs.json)"

npm run smoke:integrated-demo -- \
  --base-url "$DEMO_BASE_URL" \
  --report .local/integrated-demo-smoke.json

AWS_PROFILE="$AWS_PROFILE" AWS_REGION="$AWS_REGION" \
  npm run smoke:xray -- --report .local/xray-smoke.json

AWS_PROFILE="$AWS_PROFILE" AWS_REGION="$AWS_REGION" \
  npm run smoke:managed-metrics -- --report .local/managed-metrics-smoke.json
```

The integrated smoke calls `/health` and all three agent scenarios through the
web proxy. It expects a confirmed happy path, a confirmed slow path of at least
1.5 seconds, and the bounded HTTP 502 dependency error. Its report provides the
trace and correlation IDs used for the Grafana check.

### Configure The Unified Grafana View

Assigning the operator, changing workspace roles, and creating data sources are
AWS/Grafana mutations distinct from stack deployment. Pass the preflight, show
the intended changes, and obtain explicit approval before this sequence.

1. Follow the access-bootstrap runbook to assign only the named operator and
   promote that user temporarily to Grafana Admin.
2. Create an AMP **Prometheus** data source using the stack's
   `AmpPrometheusEndpoint`, `eu-central-1`, SigV4 authentication, and the
   workspace's customer-managed data-access role.
3. Create one **CloudWatch** data source in `eu-central-1` using the same role.
   It serves both CloudWatch metrics and Logs Insights.
4. Create one **AWS X-Ray** data source in `eu-central-1` using the same role.
5. Test all three sources, downgrade the operator to Editor, start a fresh
   session, and verify that data-source administration is no longer available.
6. Import `grafana/dashboards/movie-reservation-aws-overview.json`, mapping
   `DS_AMP`, `DS_CLOUDWATCH`, and `DS_XRAY` to those three sources.

To correlate one request, copy a `trace_id` from the integrated smoke report,
set the dashboard's **Trace ID** variable, and use the same narrow time range in
the X-Ray and CloudWatch Logs panels. Confirm:

- the X-Ray panel shows the agent and currently instrumented downstream spans;
- the Logs panel finds the same trace ID where components emit it;
- the corresponding request/error/latency metric changes are visible in the
  existing AMP or CloudWatch panels;
- the reservation MCP span gap is reported, not mistaken for proof that it did
  not execute.

## Gate 6: Teardown

Teardown is a new AWS mutation and requires explicit approval. Preserve
`ArtifactFoundationStack`, its six retained ECR repositories/images,
`CDKToolkit`, the GitHub OIDC trust stack, the customer-managed prefix list, and
the Identity Center foundation.

```bash
npm run preflight:aws
npm run cdk -- destroy MovieReservationWorkloadStack "${CDK_CONTEXT[@]}"
```

**Approval gate:** wait before running the command. After destruction, verify
that the workload stack, ALB, ECS service/tasks, VPC endpoints, log groups, AMP
workspace, Grafana workspace, and Grafana role are gone. Record the sanitized
result and complete the access-bootstrap privilege exit gate.

Do not invoke guarded artifact-foundation cleanup as part of routine demo
teardown.
