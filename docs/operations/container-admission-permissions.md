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

## Operator rollout

1. Review this policy with the matching environment consumer and producer
   evidence PRs. Merge shared evidence actions before their pinned consumers.
2. Confirm the evidence-reader GitHub App has read access to the selected
   producer's Actions artifacts and attestations. Producers receive no AWS role.
3. Using the private trust configuration and existing account preflight, review
   a diff of **only `GitHubOidcTrustStack`**. Expect five additional exact ECR
   repository resources in the admission statement, not new trust claims or
   deployment permissions. Stop on unrelated changes.
4. Deploy that reviewed stack only after operator approval. This PR does not
   perform deployment or change GitHub settings.
5. In the environment repository, select a successful canonical producer run
   that emitted the new evidence package, then use protected admission. A
   historical image without that package cannot bypass verification.

Admission verifies or copies an exact digest. It does not select a release or
deploy ECS. Follow the environment repository's operator instructions for those
separate stages. Reverting this policy removes the five additional destinations
from future admissions; it does not delete existing images.

## Offline checks

`npm run build`, `npm run test:cdk` and `npm run synth:github-oidc-trust`
exercise the implementation using synthetic configuration. They do not prove
that live IAM, GitHub App installation or a real candidate admission works.
