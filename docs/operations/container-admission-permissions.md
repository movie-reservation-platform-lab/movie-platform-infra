# Container admission permissions

The existing `GitHubOidcTrustStack` admission role supports six explicitly
approved runnable containers: reservation-service, reservation-web,
reservation-agent, recommendation-service, reservation-mcp and recommendation-mcp.
Their repository names come from the artifact-foundation catalog; future catalog
entries do not automatically receive admission permission.

This change grants the existing seven ECR read/upload actions against six exact
repository ARNs. It does not alter GitHub OIDC claims, the protected environment,
the deployment role, or repository lifecycle policies. `GetAuthorizationToken`
still requires its service-level wildcard. No additional resources are created.

## Current consumer contract

As reviewed on 2026-09-15, environment PR #84 delivered all-six admission and
PR #97 activated hosted v1alpha3 for the five additional producers. Shared actions
PR #13 supplies the governed vulnerability evidence implementation. These
dependencies are merged; this IAM expansion still needs its own rollout.

| Component | Exact ECR repository name | Hosted evidence |
| --- | --- | --- |
| reservation-service | movie-reservation-service | v1alpha1 pilot |
| reservation-web | movie-reservation-web | v1alpha3 runnable container |
| reservation-agent | movie-reservation-agent | v1alpha3 |
| recommendation-service | movie-recommendation-service | v1alpha3 |
| reservation-mcp | movie-reservation-mcp | v1alpha3 |
| recommendation-mcp | movie-recommendation-mcp | v1alpha3 |

The web static-site OCI bundle is outside this admission path. The reviewed
environment profile selects the evidence contract before downloading evidence;
the candidate cannot choose its own trusted source or ECR destination.

V3 admission checks the original four-file signed package and protected receipt,
then evaluates the original scan findings against the current approved policy
from `movie-platform-actions` before registry access. Expired, withdrawn or
out-of-scope exemptions cannot cover CRITICAL findings. Policy acquisition errors
fail closed. This is a fresh policy decision against the original scan, not a new
vulnerability scan. The reservation-service pilot retains its existing rules.

Evidence and policy checks belong to the environment consumer. IAM supplies the
bounded ECR capability after those checks; it cannot inspect an evidence package
or enforce an exemption decision. The v3 workflow preserves the existing exact
OIDC workflow identity and protected environment, so no trust-config schema,
AWS action or additional role is needed for this contract update.

## Operator rollout

1. Review this policy with the merged environment consumer and producer
   evidence contracts. Consult the environment-owned
   [container admission runbook](https://github.com/movie-reservation-platform-lab/movie-platform-environments/blob/main/docs/operations/container-candidate-admission.md)
   for exact workflow inputs and private configuration. Confirm its reviewed
   hosted profiles and producer action pins are present on canonical `main`.
2. Confirm the evidence-reader GitHub App has read access to the selected
   producer's Actions artifacts, attestations and metadata. For the five v3
   producers, also confirm the separate policy-reader App has Contents and
   Metadata read access to `movie-platform-actions`, with its credentials in the
   protected admission environment. The producer evidence token is not reused
   for policy access. Verify the environment's required reviewers and branch
   restrictions; workflow YAML does not establish those settings. Producers
   receive no AWS role.
3. Using the private trust configuration and existing account preflight, review
   a diff of **only `GitHubOidcTrustStack`**. Expect five additional exact ECR
   repository resources in the admission statement, not new trust claims or
   deployment permissions. Stop on unrelated changes.
4. Deploy that reviewed stack only after operator approval. This PR does not
   perform deployment or change GitHub settings.
5. In the environment repository, select an exact successful canonical producer
   `main` publication run with its expected attempt and image digest, then use
   protected admission. A PR scan is not publication evidence, and a historical
   image without the required retained package cannot bypass verification.
   Recommendation-service requires explicit `main` selection even if its default
   branch differs. Hosted profiles select v3 for non-pilot producers; do not
   relabel old evidence or fall back to manual copying when a gate fails.
6. Check the successful admission result's component, exact destination digest
   and method: the pilot uses `reservation-artifact-admission-result-v1`; v3 uses
   `container-artifact-admission-result-v3`. Compatibility filenames still end
   in `v1.json`, so inspect the body. Retain the protected receipt, original v3
   package and result when audit needs exceed the hosted 14-day artifact
   retention. The v3 result records that attempt's current policy identity,
   decision time and dispositions; it does not authorize a later attempt.

Admission verifies or copies an exact digest. It does not select a release or
deploy ECS. Follow the environment repository's operator instructions for those
separate stages. Read-only vulnerability diagnostics can explain blockers, but
their output is not admission authority. See the environment-owned
[vulnerability-policy runbook](https://github.com/movie-reservation-platform-lab/movie-platform-environments/blob/main/docs/operations/vulnerability-policy.md)
for policy access failures, current CRITICAL findings and approved retry paths.

## Rollback

Coordinate with the environment operator to pause affected non-pilot admissions,
reject pending approvals and cancel queued or active runs before reviewing an
IAM rollback. Preserve receipts and reconcile interrupted transfers; cancelling
a run does not undo an image copy. Review and deploy the trust-stack rollback
separately. Removing the five additional destinations removes their admission
permission; it does not delete existing images or change selected releases.
Keep the reservation-service pilot outside this rollback scope. Reverting only
the hosted workflow is a separate operation and does not remove IAM capability.

## Offline checks

`npm run build`, `npm run test:cdk` and `npm run synth:github-oidc-trust`
exercise the implementation using synthetic configuration. They do not prove
that live IAM, GitHub App installation or a real candidate admission works.
GitHub CI runs `test:cdk:github-oidc-trust` and `synth:github-oidc-trust` explicitly.
The tests check exact resource/action sets, actual role attachments, absence of
additional inline/managed policies and failure on a missing approved destination.
Run `npm run ci` for the full repository gate.
