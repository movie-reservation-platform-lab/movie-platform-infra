# Implementation Plan: Parameterized GitHub OIDC Trust Roles

## 1. Summary

Issue #28 adds a separately synthesized public CDK stack that defines two
independent GitHub Actions OIDC entry roles:

- an artifact-admission role with write/read access only to the trusted
  reservation-service ECR repository; and
- a deployment role that can assume only the exact CDK bootstrap roles for the
  selected account, Region, and qualifier.

The stack accepts exact private GitHub identities through a required JSON
configuration file supplied at synthesis/deployment time. The public repository
contains only fake test configuration. This slice synthesizes and tests the
roles but does not deploy or assume them.

## 2. Goals

- Replace long-lived AWS credentials with short-lived GitHub OIDC sessions.
- Keep artifact admission and deployment trust and permissions separate.
- Enforce exact repository, workflow, branch, GitHub Environment, audience, and
  subject claims without wildcards.
- Scope admission to the existing trusted ECR repository.
- Keep private repository identities and AWS account IDs out of public source.
- Exercise config parsing, synthesized IAM policy shape, and the real CDK
  entrypoint entirely offline.

## 3. Non-goals

- Deploying, assuming, or live-testing either role.
- Adding private bindings or privileged workflows to this public repository.
- Changing the artifact-copy implementation or admitting a live candidate.
- Designing the complete environments #17 orchestration.
- Rebootstrapping the AWS account or broadening the approved single-manifest
  artifact boundary.
- Claiming that an OIDC entry role alone makes the default CDK CloudFormation
  execution policy least-privilege.

## 4. Current State

- `ArtifactFoundationStack` creates and retains the immutable
  `movie-reservation-service` ECR repository but deliberately creates no IAM or
  OIDC resources.
- `ARTIFACT_FOUNDATION_REPOSITORIES` is the infra-owned destination catalog.
- `automation/artifact-copy` performs exact single-manifest transfer and
  verification but owns no credentials or AWS trust.
- `bin/artifact-foundation.ts` and `bin/infra.ts` demonstrate separate CDK app
  entrypoints and offline synth scripts.
- `test/artifact-foundation.test.ts` asserts the foundation stack remains free
  of IAM/OIDC concerns; issue #28 must preserve that boundary.
- The account already uses the modern CDK bootstrap roles. The OIDC deployment
  entry role therefore needs `sts:AssumeRole` only for the exact deploy, file
  publishing, image publishing, and lookup role ARNs selected by account,
  Region, and bootstrap qualifier.

## 5. Requirements and Assumptions

### Confirmed Requirements

- Public source must not contain real private repository names, workflow
  identities, AWS account IDs, or credentials.
- Admission and deployment use distinct roles, policies, workflows, and GitHub
  Environments.
- Both roles trust only canonical `main` execution from a configured private
  repository and approved workflow.
- The admission role can mutate only the trusted ECR artifact path.
- The deployment role cannot perform artifact admission.
- No AWS mutation occurs in this slice.

### Assumptions

- The target account has one modern CDK bootstrap stack with a known
  nine-character qualifier, initially `hnb659fds`.
- Private Unit 8 supplies exact GitHub claim values and protects the configured
  GitHub Environments.
- Each privileged workflow has a distinct exact workflow name and environment.
- The repository uses the GitHub OIDC subject format reflected by the supplied
  exact `subject` value. The parser does not construct a subject from public
  assumptions because GitHub now supports both name-based and immutable-ID
  subject formats.
- The deployment workflow pins reviewed infra code and validated release input.
  IAM cannot prove which Git revision a workflow checked out.

### Open Questions

None for offline implementation. Before the deployment role is used, the
effective permissions of the account's CDK `CloudFormationExecutionRole` and
any permissions boundary still require a separate live-account review.

## 6. Proposed Design

### Configuration Boundary

Add a dependency-free parser for a required JSON file selected through
`-c githubOidcTrustConfigFile=<path>`. Parse it once at the entrypoint and pass
a typed value into the stack.

The file contains:

- a schema version;
- the CDK bootstrap qualifier; and
- separate `admission` and `deployment` GitHub identities.

Each identity requires exact `subject`, `repository`, `repositoryId`,
`repositoryOwnerId`, `workflow`, `ref`, and `environment` strings. Validation
requires `ref` to be `refs/heads/main`, rejects whitespace, wildcard and
template characters, rejects documented placeholder markers, and rejects
different repository or owner identities across the two roles. Admission and
deployment must use separate workflows and GitHub Environments. The supplied
subject remains an opaque exact claim so this public parser is not coupled to
one GitHub subject format. Error messages name invalid fields or keys without
echoing their private values.

### Trust Stack

Add `GitHubOidcTrustStack` as a third CDK app, separate from the persistent
artifact foundation and disposable workload stacks. It creates one
`AWS::IAM::OIDCProvider` for `https://token.actions.githubusercontent.com` with
the `sts.amazonaws.com` audience.

Each role trust policy uses `StringEquals` for:

- `token.actions.githubusercontent.com:aud`;
- `token.actions.githubusercontent.com:sub`;
- `token.actions.githubusercontent.com:repository`;
- `token.actions.githubusercontent.com:repository_id`;
- `token.actions.githubusercontent.com:repository_owner_id`;
- `token.actions.githubusercontent.com:workflow`;
- `token.actions.githubusercontent.com:ref`; and
- `token.actions.githubusercontent.com:environment`.

This deliberately avoids `StringLike`. AWS now exposes the listed GitHub claims
as trust-policy condition keys. `job_workflow_ref` is not required in the first
slice because the approved private jobs are not yet defined as reusable
workflow calls; a later reusable-workflow design can add that exact claim.

Set the maximum role session duration to one hour and publish separate role ARN
outputs for private discovery.

### Admission Permissions

Build the reservation repository ARN from the stack account/Region and
`ARTIFACT_FOUNDATION_REPOSITORIES`; do not accept an arbitrary destination
repository from the caller.

Grant the ECR upload and exact verification actions required by the approved
copy mechanic on that ARN only:

- `ecr:BatchCheckLayerAvailability`;
- `ecr:BatchGetImage`;
- `ecr:CompleteLayerUpload`;
- `ecr:DescribeImages`;
- `ecr:InitiateLayerUpload`;
- `ecr:PutImage`; and
- `ecr:UploadLayerPart`.

Grant `ecr:GetAuthorizationToken` separately on `*`, because AWS does not
support repository resource scoping for that action. Add no delete, repository
administration, CloudFormation, IAM, ECS, S3, or STS role-assumption permission.

### Deployment Permissions

Grant only `sts:AssumeRole` for the exact modern-bootstrap role ARNs derived
from the stack account, Region, and validated qualifier:

- deploy role;
- file-publishing role;
- image-publishing role; and
- lookup role.

The role receives no direct ECR admission actions and no GitHub write
credential. The bootstrap `CloudFormationExecutionRole` remains the effective
CloudFormation permission boundary; its live policy must be reviewed before
environments #18, because the default bootstrap policy may be administrative.

## 7. Alternatives Considered

### Add roles to `ArtifactFoundationStack`

- Pros: one stack to deploy.
- Cons: couples durable artifact storage to replaceable private identities and
  breaks the foundation's explicit no-IAM contract.
- Decision: rejected; use a separate trust stack.

### Hard-code the private repository and workflow

- Pros: simplest trust policy.
- Cons: discloses private control-plane identity in public Git and prevents
  reuse.
- Decision: rejected.

### Give the deployment entry role direct CloudFormation permissions

- Pros: avoids CDK bootstrap role assumption.
- Cons: duplicates the CDK deployment model, is difficult to scope correctly,
  and risks privilege escalation through service-role passing.
- Decision: rejected; constrain access to the existing exact bootstrap roles.

### Trust only `sub` and `aud`

- Pros: conventional minimal OIDC policy.
- Cons: misses currently supported immutable repository and exact workflow,
  branch, and environment claims.
- Decision: rejected for this security-sensitive boundary.

## 8. API / Interface Changes

- New CDK context key: `githubOidcTrustConfigFile`.
- New JSON configuration contract and TypeScript types.
- New `bin/github-oidc-trust.ts` CDK app and npm synth command.
- New CloudFormation outputs for admission and deployment role ARNs.
- No application, artifact-copy, schema, or live environment API changes.

## 9. Data Model / Persistence Changes

None. The JSON file is deployment-time configuration, not repository-owned
state. Real private instances live in the private control path and must not be
committed here.

## 10. Security, Privacy, and Abuse Considerations

- Exact claim equality and no wildcards prevent organization-wide or
  repository-wide trust expansion.
- Immutable repository and owner IDs remain enforced even if display names are
  changed.
- Separate environments/workflows reduce cross-use of the two roles.
- Role policies contain no secret material; OIDC tokens remain short-lived and
  are never handled by this CDK code.
- Public tests use unmistakably fake identities and account values.
- The admission role cannot delete images, retag repositories, administer ECR,
  deploy CloudFormation, or assume the deployment role.
- The deployment role's transitive authority is bounded by the selected CDK
  bootstrap roles and their CloudFormation execution policy. This dependency is
  documented rather than mislabeled as solved.

## 11. Performance, Scalability, and Reliability Considerations

The stack adds one provider and two roles, so synth cost is negligible. Exact
configuration intentionally fails closed when a repository, workflow,
environment, or subject changes. Rotation is a reviewed config update and
CloudFormation deployment, not a permissive wildcard fallback.

## 12. Implementation Steps

1. Add the typed config parser.
   - Files: `lib/config/github-oidc-trust-config.ts`, focused parser tests, fake
     JSON fixture.
   - Verification: valid config normalizes; missing, malformed, placeholder,
     wildcard, non-main, and non-separated identities fail without value leaks.
2. Add the independent trust stack.
   - Files: `lib/github-oidc-trust-stack.ts`, `bin/github-oidc-trust.ts`.
   - Verification: synthesized provider, two roles, exact trust conditions,
     one-hour sessions, and outputs.
3. Add least-privilege policy assertions.
   - File: `test/github-oidc-trust.test.ts`.
   - Verification: ECR actions use only the trusted repository ARN;
     `GetAuthorizationToken` is the sole `Resource: *` admission statement;
     deployment has only exact bootstrap-role assumption; prohibited actions
     are absent.
4. Wire offline synthesis and documentation.
   - Files: `package.json`, `README.md`, this plan.
   - Verification: real app synth uses only fake configuration and no lookups.
5. Run repository checks and required read-only reviews.
   - Verification: focused tests, `npm run ci`, `git diff --check`, then system,
     security, and maintainability review agents.

## 13. Testing Strategy

- Pure parser tests for every required field and rejection category.
- Fine-grained CDK assertions for trust conditions, resource scoping, action
  allowlists, role separation, session duration, and outputs.
- Negative assertions for delete/admin/admission permissions on the deployment
  role and deploy/assume permissions on the admission role.
- Real credential-free `cdk synth --no-lookups` through the new entrypoint.
- Full existing `npm run ci` to prove the foundation and workload stacks remain
  unchanged.

Template tests prove emitted CloudFormation, not that AWS will accept or that a
private workflow can assume the deployed role. Those live checks are deferred
because this slice is explicitly non-deploying.

## 14. Rollout / Migration Plan

This PR adds only offline mechanics. After merge, Unit 8 supplies real private
configuration and a separately reviewed deployment action can synthesize and
diff the trust stack. Deployment still requires explicit user authorization.

Rollback before deployment is a normal revert PR. After deployment, rotate or
remove trust through a reviewed CloudFormation change; do not delete the
persistent ECR foundation as part of trust rollback.

## 15. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
| --- | ---: | ---: | --- |
| Trust accidentally covers another repository/workflow | Critical | Low | Exact subject plus repository IDs, workflow, ref, and environment; reject wildcards |
| Public source reveals private control identities | High | Low | Runtime config file; fake public fixture only; sanitized errors |
| Admission role can mutate another ECR repository | Critical | Low | ARN derived from infra-owned catalog; action/resource assertions |
| Deployment role is described as more restricted than its bootstrap execution role | High | Medium | Document transitive boundary and require live policy review before #18 |
| Provider conflicts with another stack owning the GitHub IdP | High | Low | Make this stack the documented account-level owner before first deploy; inspect live diff |
| Claim-format change causes outage | Medium | Medium | Exact supplied subject; fail closed; rotate via reviewed private binding change |

## 16. Done Criteria

- Issue #28 has one reviewable local branch with plan, implementation, tests,
  and public documentation.
- No real private or AWS identity appears in tracked files.
- Synthesized trust and permission policies satisfy the exact allowlists.
- Existing stacks and tests still pass.
- The new app synthesizes offline with fake configuration.
- No role is deployed or assumed.

## 17. Review Checklist

- [x] Requirements and non-goals are explicit.
- [x] Existing stack/config/test conventions were inspected.
- [x] Alternatives were considered.
- [x] Security and transitive deployment authority are explicit.
- [x] Testing layers and their limits are explicit.
- [x] Rollout and rollback are defined.
- [x] Implementation steps are ordered and concrete.

## 18. Handoff Prompt for Implementation Agent

```text
Implement docs/plans/github-oidc-trust-roles.md for infra issue #28.

Keep the trust stack separate from the artifact foundation and workload stacks.
Accept real GitHub identities only through the required runtime config file.
Use exact trust conditions, repository-scoped admission permissions, and exact
CDK bootstrap role ARNs. Do not deploy, assume roles, contact AWS, or add real
private identities. Run focused tests, npm run ci, and git diff --check. If the
installed CDK output differs from the plan, update the plan before broadening
permissions.
```

## Sources

- `docs/plans/reservation-artifact-copy-mechanics.md`
- `movie-platform-environments/docs/plans/read-only-promotion-preflight-and-proposal-cli.md`
- Programming KB: `Identity Federation`, `AWS CDK Testing Layers`, and
  `Testing Synthesized CDK Templates`
- [AWS IAM GitHub OIDC condition keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html)
- [GitHub OIDC in AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)
- [AWS CDK bootstrap roles](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)
- [Amazon ECR push permissions](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-push-iam.html)
