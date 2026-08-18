# Implementation Plan: Standalone-Account Identity Center And Grafana Access Bootstrap

> Status: approved on 2026-08-18 for the plan-only PR 1 of issue
> [#14](https://github.com/movie-reservation-platform-lab/movie-platform-infra/issues/14).
> Approval covers this design record and release decomposition only. It does
> not approve the existing draft implementation, PRs 2–4, or any AWS mutation.
> No AWS account has been mutated or deployment performed.

Last reviewed: 2026-08-18

## Review Decision Log

Decision review completed 2026-08-18. This table is normative; later sections
translate it into implementation and release work.

| Topic | Confirmed decision |
| --- | --- |
| 1. Outcome | Provide both short-lived CLI SSO and usable Managed Grafana access. |
| 2. Account topology | Start with the existing account as management and workload account; preserve a later migration to a management-only account plus member workload account. |
| 3. Identity source | Use the built-in IAM Identity Center directory; no external IdP is available. |
| 4. Initial privilege | Use one-hour `AdministratorAccess` only for bootstrap and one deploy/teardown rehearsal; require a tested least-privilege replacement before a second deployment. |
| 5. MFA/recovery | Require Google Authenticator TOTP on every sign-in. Accept the initial same-phone root/operator MFA weakness, verify independent root recovery contacts, and add a second physical authenticator later. Do not require LastPass, FIDO2, or a YubiKey initially. |
| 6. Region | Use `eu-central-1` for the durable Identity Center instance and initial workload. |
| 7. Ownership | Keep persistent organization/identity bootstrap outside the disposable stack; start with a complete manual console runbook. |
| 8. Automation boundary | Initial scripts are read-only discovery, validation, preflight, and postcondition checks. Add idempotent mutations only in later small PRs after the manual rehearsal. |
| 9. Grafana role | Give the sole operator temporary Admin only for data-source setup, then Editor for dashboard import and normal use; defer multi-user/Viewer design. |
| 10. Identity pin | Match an explicit profile, exact account, `eu-central-1`, permission set, and full generated role name; fail closed when the role changes. |
| 11. Credentials | Accept only AWS CLI v2 SSO token-provider credentials for humans; reject every static/alternate source. Design future workload identity separately. |
| 12. Lifecycle/cost | Preserve the zero-additional-charge identity foundation, remove temporary Admin, and destroy the billable workload after each demo. Track retained artifact/foundation charges separately. |
| 13. Preflight timing | Rerun immediately before each distinct mutation group and after a new/renewed SSO session; do not build a mutating wrapper now. |
| 14. Target storage | Keep the independent target pin in an operator-owned XDG config file outside Git, with an explicit alternate-file override; parse it as inert data. |
| 15. Output privacy | Print only profile, Region, permission-set name, and account last four; never print full IDs, suffixes, ARNs, identities, or sessions, and provide no revealing verbose mode. |
| 16. Verification | Require deterministic fake-CLI tests in offline CI plus one explicitly approved live rehearsal. Keep scaffolding and its tests together through future automation/repository splits. |
| 17. Completion gates | Merge reviewed repository PRs first; mutate AWS only after separate approval; call the release complete only after the live rehearsal passes. |
| 18. Existing draft | Treat every current change as unapproved evidence; retain only work reconciled with this plan and review it as new. |
| 19. PR structure | Use four sequential PRs: plan; bootstrap runbook/navigation; preflight/tests/CI; deployment/lifecycle/release integration. Then run the separately approved rehearsal. |

### PR 3 implementation refinement

On 2026-08-18, the operator approved replacing the Bash draft with TypeScript
and clarified that deployment scaffolding is an automation building block, not
CDK application or business code. The preflight therefore lives under
`automation/aws-account-preflight/` with its own TypeScript and Jest
configuration. The root infrastructure build and test suite exclude it; the
aggregate CI command invokes its separate typecheck, behavior tests, and
self-test explicitly. If ownership later moves to a dedicated automation
repository, the source, configuration, tests, and CI gate move together.

During the PR 3 code review, the operator then approved the maintainability
refinement: use Node's standard `parseArgs`, replace the bespoke pseudo-conf
grammar with a JSON target manifest plus explicit runtime validation, split the
implementation by runtime boundary, narrow the public CLI seam, and move the
fake AWS executable into a dedicated test fixture. These changes preserve the
approved identity, privacy, and release-gate contract while making the target
format portable to a future Python, TypeScript, or Rust owner.

Consolidated plan approval does not approve the existing draft wholesale,
authorize AWS mutations, or skip per-PR review.

## 1. Summary

Document the one-time conversion of the existing standalone pay-as-you-go AWS
account into the management account of an all-features AWS Organization, then
enable an organization instance of IAM Identity Center in `eu-central-1` with
the built-in directory. Create one named operator, require MFA, and temporarily
assign the predefined `AdministratorAccess` permission set for bootstrap and the
first demo deployment.

Add a read-only, locally testable AWS account preflight. Before a workstation
mutation, it will require an explicit SSO profile, expected account ID, fixed
Region, and exact generated Identity Center role name; inspect the profile; call
STS; and fail unless every value agrees. The runbook will separately explain
how to assign the same operator temporarily as Admin of the disposable Managed
Grafana workspace for data-source configuration, then downgrade it to Editor
for dashboard import and normal use.

This is a security-sensitive operations and deployment-contract change. It is
a design-review plan because organization-wide identity resources outlive the
disposable CDK stack and mistakes can either lock out the operator or grant
unintended administrator access.

## 2. Goals

- Give a new operator an end-to-end path from standalone-account root access to
  a successful `aws sso login` using short-lived credentials.
- Create and verify an all-features AWS Organization with the existing account
  as its only management account; do not create another AWS account.
- Treat management-account workload deployment as an explicit exception for
  this first disposable lab and preserve a documented path to a separate member
  workload account later.
- Enable an organization instance, not an account instance, of IAM Identity
  Center in `eu-central-1` because Amazon Managed Grafana does not integrate
  with account instances.
- Use the built-in Identity Center directory for the single lab operator and
  require MFA on every sign-in.
- Make the temporary `AdministratorAccess` permission set and its replacement
  by a future least-privilege deployment permission set explicit.
- Fail before workstation mutation when the SSO profile, account, Region, or
  exact assumed role differs from the operator's expected values.
- Document Managed Grafana workspace assignment, temporary Admin setup, and
  downgrade to Editor as separate application-authorization steps after
  deployment.
- Make lifecycle, teardown, cost, root-user, and credential-handling boundaries
  explicit.

## 3. Non-goals

- Do not add AWS Control Tower or create member accounts in this issue. A
  member workload account remains the intended later migration path.
- Do not configure an external SAML identity provider, SCIM, Active Directory,
  GitHub OIDC, or automated deployment/promotion roles.
- Do not design the final least-privilege deployment permission set in this
  issue.
- Do not create IAM users, root access keys, IAM-user access keys, or any other
  long-lived workstation credentials.
- Do not manage Organizations, Identity Center instances, users, groups,
  permission sets, account assignments, or Grafana user assignments from
  `GoldenPathDemoStack`.
- Do not change the existing Grafana workspace, data-access IAM role, network
  access, ECS service, or other CDK resources.
- Do not deploy, destroy, bootstrap, or otherwise mutate the real AWS account as
  part of repository implementation.
- Do not commit an account ID, personal email address, SSO start/issuer URL,
  generated role name, cached SSO token, or credentials.

## 4. Current State

- `lib/infra-stack.ts` creates a disposable `AWS::Grafana::Workspace` with
  `AuthenticationProviders: ['AWS_SSO']`, customer-managed data-source
  permissions, prefix-list network access, and stack outputs
  `GrafanaWorkspaceId` and `GrafanaWorkspaceUrl`.
- The workspace's service role lets the Grafana service query AMP and
  CloudWatch. It is not a human login role and does not assign any operator to
  the workspace.
- `docs/operations/aws-cdk-deployment.md` documents CDK deployment, prefix-list
  preflight, smoke checks, and teardown. It shows `get-caller-identity`, but no
  executable check enforces the expected account, Region, or role.
- `README.md` and the deployment runbook already state that Organizations and
  IAM Identity Center are external account prerequisites that survive stack
  teardown, but neither explains how to create or verify them.
- The repository's shell smoke helpers establish useful fail-closed,
  deterministic self-test, and stub-executable patterns. The preflight retains
  those behaviors in an isolated TypeScript automation boundary rather than
  extending the CDK application or its infrastructure test suite.
- `package.json` exposes validation commands and combines them in `npm run ci`.
  There is no account-preflight command today.
- The working tree began clean on `main`; no remote issue #14 branch or pull
  request existed when planning started. Work continues on the local branch
  `issue-14-identity-center-grafana-bootstrap`.

Draft reconciliation found useful structure but several now-rejected
contracts. The draft Bash script/tests take four exported target variables and
print the full account and generated role; the runbook and deployment docs
teach the same environment-variable flow. They must move to the private target
file and redacted output. The runbook currently stops with persistent Grafana
Admin rather than demonstrating Admin-to-Editor downgrade, does not capture the
accepted Google-Authenticator/same-phone recovery choice, and does not enforce
the two release gates. Preserve conforming validation/test patterns, but review
their rewritten behavior as new work and partition the combined draft into the
four approved PRs.

Local Programming KB findings used by the design:

- `concepts/AWS IAM Identity Center.md` separates identity source, account
  assignment, permission set, Grafana workspace role, and Grafana data-access
  role, and treats organization setup as a lifecycle outside application CDK.
- `decisions/Prefer the IAM Identity Center Directory for Personal AWS Access.md`
  recommends the built-in directory for a personal organization without an
  existing authoritative workforce directory.
- `patterns/Federated Workforce Access.md` requires authentication, application
  assignment, application role, workload permissions, sessions, and teardown
  to remain explicit rather than collapsing them into “SSO works.”

Current AWS documentation confirms that all-features is the recommended/default
Organizations mode, Managed Grafana is not integrated with account instances,
permission sets require an organization instance, CLI SSO uses short-lived role
credentials, and Grafana workspace access is managed in the Managed Grafana
console or API after the identity exists.

## 5. Requirements and Assumptions

### Acceptance Requirements

The decision table is the normative requirement set. The implementation must:

- provide a complete manual path from secured root bootstrap to MFA-backed CLI
  SSO and final Grafana Editor access, including the accepted single-account
  and same-phone exceptions;
- keep persistent identity outside `GoldenPathDemoStack`, temporary privileges
  time-boxed, billable workload disposable, and later member-account migration
  possible;
- add only read-only automation: a fail-closed, exact-identity preflight using
  the private target file and redacted output;
- test the scaffold offline without credentials, keep its tests with it, and
  require separately approved live acceptance;
- deliver four independently reviewable PRs and withhold AWS mutation and
  release completion until their respective explicit gates.

### Implementation Defaults

- Create or identify one named operator.
- Configure and verify a dedicated AWS CLI SSO profile such as
  `movie-platform-demo`.
- Record root-only break-glass use, prohibition of long-lived human
  credentials, and independent account-prerequisite teardown.

### Assumptions

- The existing standalone account is the intended management and workload
  account for this first single-account demo only. Later multi-account
  migration will keep it as the management account and redeploy the disposable
  workload into a member account.
- The account has no organization instance of IAM Identity Center in another
  Region and no account instance that must first be removed.
- The operator will keep real values only in the dedicated local target file
  and normal AWS CLI configuration, never in version-controlled files.
- The preflight gates workstation commands after the SSO operator exists. The
  initial console-only root bootstrap must instead use explicit console account
  and Region verification because no SSO profile exists yet.

### Pre-deployment Inputs

- Verify whether root MFA is registered only on the same phone planned for the
  Identity Center operator, and verify that the root account email and primary
  contact phone are independently accessible and current.
- What is the real target account ID and exact generated
  `AWSReservedSSO_AdministratorAccess_<suffix>` role name?
- What operator username/email and access-portal or issuer URL will be used?
- Is an Organization or an Identity Center instance already partially
  configured in the account?
- Which permissions will replace `AdministratorAccess` after the first demo?

These are runtime facts or later least-privilege design work rather than open
decisions in this plan. They do not block repository implementation. Resolve
and verify them locally before the applicable real AWS mutation; none of their
values belong in Git.

## 6. Proposed Design

### Persistent account bootstrap runbook

Add `docs/operations/standalone-account-access-bootstrap.md` as the
authoritative procedure. It will use a console-first bootstrap sequence:

1. Secure the root user with MFA, verify account ownership, and use root only
   while no federated administrator exists.
2. Create or verify an all-features Organization with the existing account as
   management account and no new member accounts.
3. In the Frankfurt Region, enable the organization instance of IAM Identity
   Center and verify the instance type and Region.
4. Retain the default built-in directory, create one named operator, require MFA
   every sign-in, require device registration, and activate the operator.
5. Create the predefined `AdministratorAccess` permission set, assign it to the
   operator for the management account, verify provisioning, sign out root, and
   use root only for break-glass/account-owner tasks thereafter.
6. Configure an AWS CLI v2 SSO token-provider profile named
   `movie-platform-demo`, log in, and collect the exact account/role values from
   read-only calls without saving them in the repository.
7. Run the repository preflight before CDK bootstrap/deploy/destroy or manual
   AWS mutations.
8. After stack deployment, use the Managed Grafana console to assign the same
   Identity Center operator, promote it temporarily to workspace Admin, create
   and test the AMP and CloudWatch data sources, downgrade it to Editor, import
   the dashboard, and verify the final permission record and MFA-backed login.

The runbook will distinguish the permission-set role used to administer the AWS
account from the temporary Grafana Admin/final Editor role used inside the
workspace and from the stack-created IAM service role used by Grafana to query
metrics.

### Executable preflight contract

Add the isolated TypeScript building block under
`automation/aws-account-preflight/`, exposed as `npm run preflight:aws`.
Read the independent target expectation from
`${XDG_CONFIG_HOME:-$HOME/.config}/movie-platform/aws-target.json` by default.
Allow `MOVIE_PLATFORM_AWS_TARGET_FILE` to select another absolute file later,
for example when a member workload account is introduced. The file uses this
strict JSON placeholder-only shape:

```json
{
  "profile": "movie-platform-demo",
  "region": "eu-central-1",
  "accountId": "<12-digit-account-id>",
  "expectedRoleName": "AWSReservedSSO_AdministratorAccess_<generated-suffix>"
}
```

The runbook creates the containing directory and file manually with
operator-only permissions. The building block must parse it as inert data,
reject non-object JSON, unknown or missing keys, wrong runtime types, and
invalid values; require a regular operator-owned file with no group/other
access; and never print its contents. `JSON.parse` owns syntax while the target
validator converts `unknown` into the TypeScript `AwsTarget` contract. Keeping
this expectation separate from `~/.aws/config` preserves the independent
comparison that makes the preflight useful.

The building block will:

1. validate all inputs locally and require AWS CLI v2;
2. reject explicit AWS access-key/session-token environment variables;
3. read the named profile's `sso_account_id`, `sso_role_name`, `sso_session`,
   SSO session `sso_region`, and default `region` and reject any long-lived
   profile access key;
4. require the profile account, profile Region, and SSO session Region to match
   the expected values and the selected Region to be exactly `eu-central-1`;
5. require the exact expected generated role name to correspond to the
   profile's selected permission-set name;
6. call `sts:GetCallerIdentity` using explicit `--profile` and `--region`;
7. parse the STS assumed-role ARN, reject root/IAM-user/other-role credentials,
   and compare the actual account and generated role name exactly;
8. print only the profile, Region, permission-set name, and final four account
   digits on success; mismatch errors identify the field but reveal neither the
   expected nor actual full identifier. Never expose the generated role suffix,
   ARN, role-session name, user email, token, or credentials.

The check is intentionally read-only. It does not create a reusable approval
artifact because credentials, profile configuration, and role assignment can
change between commands; operators should rerun it immediately before each
mutation group.

### Testability and documentation integration

- Parse `--help` and `--self-test` with Node's standard `parseArgs`; do not add a
  third-party CLI framework for two boolean options.
- Add `--self-test` for pure JSON-target and role-ARN validation without AWS
  access.
- Add a separate Jest automation suite using a stub `aws` executable to prove
  input failures happen before STS, mismatches fail closed, IAM-user
  credentials are rejected, and neither success nor failure output reveals
  full account/role/session identifiers. Keep the Bash stub in a dedicated test
  fixture instead of embedding it in TypeScript. The root infrastructure Jest
  suite must not discover or run these tests.
- Keep the implementation readable by separating CLI, target schema,
  filesystem trust, AWS CLI, orchestration, self-test, and executable-entrypoint
  responsibilities while exposing only the CLI seam to black-box tests.
- Add a building-block-specific TypeScript configuration and exclude the
  automation tree from the root infrastructure build.
- Add `validate:aws-account-preflight` and include it in `npm run ci`.
- Link the account bootstrap runbook from `docs/operations/README.md`,
  `docs/README.md`, `README.md`, and the existing deployment runbook.
- Update deployment and teardown commands so the preflight is an explicit gate
  and the lifecycle table separates account prerequisites, CDK bootstrap,
  foundation/external resources, and disposable workload resources.

## 7. Alternatives Considered

### Alternative A: Documentation-only copy/paste checks

- Pros: smallest change; no executable maintenance.
- Cons: comparisons remain manual, role shape is easy to misread, there is no
  regression test, and the current runbook already demonstrates that merely
  printing caller identity is weaker than failing closed.
- Decision: rejected. Keep explanatory commands in the runbook, but put the
  deploy gate in a deterministic automation building block.

### Alternative B: Manual account bootstrap plus tested read-only preflight

- Pros: respects the persistent/disposable lifecycle boundary, avoids root API
  keys, keeps secrets out of Git, is testable offline, and uses the existing
  TypeScript toolchain without coupling to the CDK application.
- Cons: account bootstrap and Grafana assignment remain deliberate manual
  tasks; an operator can still bypass the documented preflight.
- Decision: recommended for this one-account learning/demo slice.

### Alternative C: Manage Organizations and Identity Center in CDK

- Pros: desired state could be reviewed as code.
- Cons: puts account-wide identity lifecycle under a disposable stack, risks
  lockout or destructive teardown, requires personal identity data in an IaC
  workflow, and does not fit the current stack ownership boundary.
- Decision: rejected.

### Alternative D: Add a universal mutation wrapper

- Pros: could make bypass harder by executing preflight and the mutation in one
  process.
- Cons: the repository currently exposes many direct AWS/CDK commands, wrapper
  scope and argument handling would be broader than issue #14, and it still
  cannot gate manual console changes.
- Decision: defer to a future controlled environment/deployment workflow. For
  now, rerun the focused preflight immediately before each mutation group.

## 8. API / Interface Changes

- New command: `npm run preflight:aws`.
- New validation command: `npm run validate:aws-account-preflight`.
- New local JSON target-file contract with `profile`, `region`, `accountId`,
  and `expectedRoleName`; optional environment override:
  `MOVIE_PLATFORM_AWS_TARGET_FILE`.
- `REGION` is deliberately constrained to `eu-central-1` for this demo.
- The profile must be an AWS CLI v2 SSO token-provider profile with no static
  access keys.
- No CDK application module, CDK context, CloudFormation, application API,
  event, database, dashboard schema, or deployed-resource contract changes.

## 9. Data Model / Persistence Changes

No application persistence or schema changes.

AWS Organizations, the IAM Identity Center instance/directory/operator,
permission set, account assignment, AWS CLI config, and later Grafana user
assignment are persistent control-plane state outside application data. The
Organizations and Identity Center portions survive routine CDK destroy. Cached
SSO tokens are local ephemeral state under the AWS CLI's normal cache and must
not enter the repository.

### Lifecycle and cost boundary

| Layer | Routine post-demo action | Survives `cdk destroy` | Idle-cost expectation |
| --- | --- | --- | --- |
| AWS Organization | Preserve | Yes | No additional Organizations charge |
| IAM Identity Center instance, directory operator, and MFA | Preserve | Yes | No additional Identity Center charge |
| Least-privilege permission set and account assignment | Preserve after it replaces temporary Admin | Yes | No additional IAM/Identity Center charge |
| Temporary `AdministratorAccess` assignment | Remove after the first rehearsal | No, by policy rather than stack teardown | No direct charge, but unacceptable standing privilege |
| Local AWS CLI profile and cached SSO session | Preserve profile; let sessions expire normally | Local only | No AWS charge |
| CDK bootstrap and repository-external artifact/foundation resources | Preserve unless separately retired | Yes | Standard storage/request or resource charges can remain |
| `GoldenPathDemoStack`, including Managed Grafana | Destroy promptly after each demo | No | Billable while deployed; not part of the zero-cost identity foundation |

[AWS Organizations is offered at no additional charge](https://docs.aws.amazon.com/organizations/latest/userguide/pricing.html),
and [IAM Identity Center is available at no additional cost](https://aws.amazon.com/iam/identity-center/resources/).
That does not make the deployed demo free. In particular, current
[Amazon Managed Grafana pricing](https://aws.amazon.com/grafana/pricing/)
requires at least one USD 9 Editor license per workspace per month even when no
user signs in; other stack resources retain their normal usage-based charges.
Treat any free trial as a temporary discount, not as the cost model.

## 10. Security, Privacy, and Abuse Considerations

- Use root only for the initial bootstrap or account-owner break-glass tasks;
  protect it with multiple MFA devices where practical and never create root
  access keys.
- Prohibit IAM users and long-lived human access keys. Reject access-key
  environment/profile configuration in the preflight instead of trusting a
  profile name alone.
- Require phone-based TOTP MFA on every sign-in for the built-in directory.
  FIDO2 authenticators may be added later but are not required for the initial
  lab. The operator accepts the initial same-phone dependency for root and
  Identity Center MFA as a documented drawback. Verify root email/contact-phone
  recovery before bootstrap and track a second physical authenticator as a
  hardening follow-up.
- `AdministratorAccess` is intentionally temporary and high risk. Keep its
  default one-hour session, assign only the named operator, use it only for
  bootstrap/first deployment, and track a least-privilege replacement.
- Compare the full generated role name rather than only the
  `AWSReservedSSO_AdministratorAccess_` prefix; the random suffix identifies the
  currently provisioned role and changes if the assignment is deleted and
  recreated.
- Never print the full account ID, generated role suffix, ARN, or STS
  role-session component because terminal output is commonly copied into logs
  or screenshots and the session may contain a username or email address. Do
  not record real identity values in test fixtures or docs.
- Grafana workspace admission and the human's temporary Admin/final Editor role
  are independent of the workspace data-access service role. Granting one must
  not be described as granting the other.
- Network reachability remains bounded by the customer-managed prefix list;
  Identity Center authentication is not a substitute for that network gate.

## 11. Performance, Scalability, and Reliability Considerations

- The preflight performs local config reads plus one STS request, so runtime and
  cost are negligible.
- Identity Center and IAM changes are eventually consistent. The runbook must
  wait for account assignment/role provisioning before testing CLI access.
- Losing the only operator's password/MFA device can require root break-glass
  recovery. Multiple MFA devices and protected root recovery reduce this risk.
- An Identity Center Region mistake has a broader lifecycle than an application
  deployment; changing the primary Region requires deleting and recreating the
  instance. The runbook therefore verifies `eu-central-1` before enabling it.
- Deleting all assignments for a permission set can delete its generated role;
  recreating an assignment yields a different suffix, causing the exact-role
  preflight to fail until the operator deliberately updates their local
  expectation.
- The single user/direct assignment is acceptable for one operator. Prefer a
  group if additional operators are added instead of duplicating individual
  assignments.

## 12. Implementation Steps

1. Reconcile each existing draft hunk against the decision table; remove or
   rewrite conflicts before assigning work to a PR.
2. Deliver PR 1 containing only this design record and its plan index entry.
3. Deliver PR 2 containing the manual bootstrap runbook and navigation links;
   review every command's intent, lifecycle, source, and placeholders.
4. Deliver PR 3 containing the JSON target validation boundary and live
   read-only preflight together with fake-CLI tests and package/CI commands.
5. Deliver PR 4 integrating the preflight, lifecycle table, and two-gate
   release checklist into the normal deployment documentation.
6. After each PR passes its scoped checks and all four merge, stop. Obtain
   separate approval before following the real-account acceptance sequence.

The exact file ownership and per-PR checks are normative in section 14. Do not
run real `aws`, `cdk bootstrap`, `cdk deploy`, or `cdk destroy` during Gate 1.

## 13. Testing Strategy

- Automation typecheck: compile only the preflight building block with its own
  TypeScript configuration and no emitted JavaScript.
- Pure self-test: JSON target parsing, role ARN parsing, and expected-role
  validation without AWS credentials.
- Separate Jest automation tests: execute the TypeScript CLI boundary with a
  dedicated stub AWS CLI fixture providing profile/config and STS responses,
  then assert fail-closed behavior and sanitized success output.
- Security regression: set access-key environment variables or profile values
  and prove STS is not called.
- Output-privacy regression: exercise success and mismatch paths and prove only
  the permitted redacted fields appear; there is no full-identity verbose mode.
- Contract regression: use fake account `111111111111`, fake profile, fake
  Identity Center role suffix, and fake session values only.
- Repository build/test separation: prove `npm run build` and `npm test` cover
  the CDK repository without discovering automation source/tests, while the
  explicit automation commands typecheck and test the building block.
- Full offline CI: confirm no AWS credentials or live lookups are needed.
- Manual acceptance, only after explicit operator approval: perform SSO login,
  preflight, first deployment, temporary Grafana Admin data-source setup,
  downgrade to Editor, dashboard import, workspace login, and teardown
  verification in the real target account. Also prove that the Organization,
  Identity Center operator, MFA-backed login, and intended surviving access
  remain usable after workload teardown, then remove temporary
  `AdministratorAccess`.
- Future-proofing contract: if this scaffolding moves to a smaller repository,
  move its fixtures, self-tests, Jest behavior tests, and CI gate with it. If
  deployment becomes automated, add a separate ephemeral-account integration
  layer rather than weakening or deleting the deterministic offline layer.

Expected local verification:

```bash
npm run validate:aws-account-preflight
npm run typecheck:automation
npm run test:automation -- --runInBand
npm run build
npm test -- --runInBand
npm run ci
git diff --check
```

## 14. Rollout / Migration Plan

### Gate 1: four repository PRs

Deliver the repository work sequentially. Each PR is reviewed and merged before
the next is opened against the updated `main`, so every diff has one purpose
and can pass on its own.

| PR | Review purpose | Owned files/change | Required verification |
| --- | --- | --- | --- |
| 1. Approved design record | Establish scope and decisions without implementation | This condensed plan and `docs/plans/README.md` only | Documentation diff, links, placeholders, and decision-log review |
| 2. Manual bootstrap runbook | Review persistent account operations independently from executable code | `docs/operations/standalone-account-access-bootstrap.md` plus documentation navigation links | Command intent review, official-source links, lifecycle/cost accuracy, no real identity values |
| 3. Tested preflight contract | Land an isolated automation building block with the tests that protect it | `automation/aws-account-preflight/`, `package.json`, root `tsconfig.json`, and this approved-plan refinement | Separate TypeScript typecheck/Jest/self-test, root build/test exclusion, and offline CI |
| 4. Deployment and release integration | Wire the approved preflight and lifecycle into normal operations | `docs/operations/aws-cdk-deployment.md`, remaining `README.md` integration, and the release checklist | Documentation diff, command ordering, links, full offline CI, and secret/identity-value scan |

Before creating these PRs, reconcile the current draft file by file against the
decision log. Partition it without ever landing the preflight separately from
its tests. None of these PRs authorizes or performs an AWS mutation.

### Gate 2: explicitly approved AWS acceptance rehearsal

1. Confirm the real account has no conflicting Organization or Identity Center
   instance and secure root recovery/MFA.
2. Use the console to create/verify the all-features Organization and enable the
   organization instance in `eu-central-1`.
3. Create and activate the operator with MFA, provision the temporary
   `AdministratorAccess` assignment, verify the access portal, then stop using
   root for daily work.
4. Configure `movie-platform-demo`, create the operator-only local target file,
   perform `aws sso login`, and pass the repository preflight.
5. Run the existing local verification, CDK bootstrap/diff/deploy workflow only
   after separate explicit approval.
6. Assign/promote the operator temporarily to Admin in Managed Grafana, create
   and test the data sources, downgrade it to Editor, import the dashboard,
   verify the final permissions and real workspace access, and capture
   sanitized evidence outside Git.
7. Destroy disposable resources promptly; verify that Organization, Identity
   Center, operator access, CDK bootstrap, and other declared prerequisites
   survive according to the lifecycle table.
8. After the first deployment/teardown rehearsal, create and test a
   least-privilege permission set, update the CLI profile/expected role, verify
   it, and remove `AdministratorAccess`. Do not perform a second workload
   deployment while the broad assignment remains.

If the rehearsal fails, stop at the failed checkpoint, avoid unrelated
mutations, and destroy any safely removable billable workload resources. Keep
the persistent identity foundation unless the failure itself makes it unsafe.
Open a narrowly scoped corrective PR, rerun its offline checks, obtain explicit
approval for another rehearsal, and do not mark issue #14 or the release
complete until the full acceptance sequence passes.

### Later member-account migration path

The single-account exception is reversible, but AWS resources are redeployed
rather than moved in place:

1. Create a member workload account inside the existing Organization; retain
   the current account as the management account and retain the existing
   organization Identity Center instance and directory identities.
2. Assign an appropriate deployment permission set to the operator for the new
   member account and add a dedicated local SSO profile/target expectation.
3. Bootstrap CDK in `eu-central-1` in the member account and create or admit the
   account-local foundation resources, including the ingress prefix list and
   private ECR repository.
4. Promote/copy the immutable application image into the member account's ECR
   repository. The current typed configuration intentionally requires the ECR
   registry account to equal the CDK deployment account; do not weaken that
   boundary merely to avoid republishing the artifact.
5. Deploy a fresh `GoldenPathDemoStack` in the member account, assign the
   existing Identity Center operator to the new Managed Grafana workspace, and
   repeat workload, telemetry, and access verification.
6. Only after the member deployment passes, destroy the disposable workload
   stack in the management account and remove workload-oriented access from
   that account. Keep only the narrowly required organization-management and
   break-glass access there.

This later migration changes account-scoped IDs, ARNs, endpoints, CDK bootstrap
resources, Grafana workspace assignment, and locally expected caller values.
It does not require recreating the Organization, Identity Center instance,
directory user, or MFA enrollment.

Rollback before workload deployment is to stop and correct the account/Region,
profile, or assignment; the preflight makes mismatches non-mutating. Rollback of
Grafana access is to unassign or demote the user. Routine rollback must not
delete the Organization or Identity Center. Account-prerequisite teardown is a
separate, deliberate procedure performed only after all dependent assignments,
applications, permission sets, and recovery consequences are understood.

## 15. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
| --- | ---: | ---: | --- |
| Root remains the daily operator | High | Medium | Complete SSO bootstrap, sign out root, protect root recovery/MFA, and prohibit root/API keys |
| Wrong account, role, or Region is mutated | High | Medium | Require exact local expectations; compare profile and live STS identity; rerun preflight immediately before mutation |
| Static credentials override the SSO profile | High | Medium | Reject explicit credential environment variables and profile access keys; require an SSO session |
| Temporary administrator access persists | High | Medium | Limit it to one-hour sessions and one deployment/teardown rehearsal; block a second workload deployment until a tested replacement is active and the broad assignment is removed |
| One lost phone removes both root and Identity Center TOTP | High | Medium | Document the accepted initial drawback; verify root email/contact-phone recovery before bootstrap; add a second authenticator on another physical device later |
| Identity Center is enabled in the wrong Region/type | High | Low | Verify account/Region first; select organization instance explicitly; document that instance migration is disruptive |
| Grafana login is confused with data-source access | Medium | Medium | Document and verify human assignment, temporary Admin/final Editor role, network gate, and IAM data-access role independently |
| Real identity/account values are committed or leaked in logs | High | Low | Use placeholders/fakes, keep target values in the dedicated local file, redact every output path, and inspect the diff with targeted secret/value searches |
| Documentation drifts as AWS consoles evolve | Medium | Medium | Link official AWS docs, keep comparisons executable in the building block, and mark live console verification as required |
| Infrastructure tests pass while isolated deployment scaffolding is broken | High | Medium | Run the separate automation typecheck, self-test, and behavior suite as explicit CI gates; require a supervised live rehearsal; move those gates with the building block if repository ownership changes |
| Operator bypasses the standalone preflight | High | Medium | Put it immediately before every documented mutation group; consider a universal deployment wrapper in a later workflow issue |

## 16. Done Criteria

### Gate 1: repository delivery

- A new runbook covers Organization creation/verification, organization-instance
  Identity Center enablement in Frankfurt, built-in-directory operator setup,
  always-on MFA, temporary `AdministratorAccess`, CLI SSO, temporary Grafana
  Admin data-source setup, final Editor assignment, costs, teardown, and
  root/credential rules.
- `npm run preflight:aws` fails closed unless the profile, exact account, fixed
  Region, and exact generated Identity Center role all match.
- The preflight rejects IAM/root/static access-key paths and exposes only the
  approved redacted profile/Region/permission-set/account-last-four summary.
- Offline self-tests and Jest fixture tests cover success and important failure
  modes without AWS credentials.
- The TypeScript automation source and tests remain outside the CDK application,
  root build, and infrastructure Jest suite, with their own explicit CI gate.
- `npm run ci` includes the new validation and passes.
- The lifecycle table clearly distinguishes account prerequisites, CDK
  bootstrap, externally owned foundation resources, and disposable stack
  resources.
- No account ID, personal email, SSO URL, token, real role name, or credentials
  appear in the diff.
- All four single-purpose PRs have been reviewed and merged in order; no AWS
  resource was mutated as part of those repository changes.

### Gate 2: release acceptance

- The operator completes a real MFA-backed SSO login and the redacted
  preflight passes against the intended account, Region, and exact role.
- The first approved bootstrap/deploy/Grafana/downgrade/destroy rehearsal
  passes, and the intended persistent identity resources remain accessible.
- Temporary `AdministratorAccess` is removed after a tested least-privilege
  replacement is active; a second workload deployment has not occurred first.
- Sanitized acceptance results are recorded without committing private account
  or identity values. Only then is issue #14/release marked complete.

## 17. Review Checklist

- [x] Requirements are explicit and user-approved
- [x] Non-goals are explicit and user-approved
- [x] Existing code conventions were checked
- [x] Alternatives were reviewed with the user
- [x] Security implications were reviewed with the user
- [x] Scalability and reliability implications were reviewed with the user
- [x] Testing strategy is approved
- [x] Rollout and rollback are approved
- [x] Implementation steps and PR boundaries are approved

## 18. Handoff Prompt For Implementation Agent

```text
Implement only the currently approved PR slice from
docs/plans/standalone-account-identity-center-bootstrap.md. Do not combine the
four PRs into one diff. Reconcile the existing working-tree draft against the
decision log before retaining any of it.

Constraints:
- Stay within issue #14 and preserve all deployed CDK resource behavior.
- Do not introduce dependencies.
- Do not deploy, destroy, bootstrap, or mutate AWS resources.
- Keep Organizations, Identity Center, operator identities, permission sets,
  account assignments, and Grafana user assignments outside the disposable CDK
  stack.
- Use fake values in tests and placeholders in docs; never commit real account,
  identity, SSO, role, token, or credential values.
- Make the live preflight read-only, fail closed, and testable without AWS.
- Read its independent pinned target from the dedicated operator-owned XDG
  config file, parse it as data without source/eval, and emit only the approved
  redacted output.
- Keep the preflight and all of its tests together in PR 3.
- Keep the automation source and tests out of the root CDK application and
  infrastructure test suite; run them through separate package commands.

Relevant files/modules:
- docs/operations/standalone-account-access-bootstrap.md
- automation/aws-account-preflight/src/cli.ts
- automation/aws-account-preflight/src/index.ts
- automation/aws-account-preflight/src/main.ts
- automation/aws-account-preflight/src/preflight.ts
- automation/aws-account-preflight/src/aws-cli.ts
- automation/aws-account-preflight/src/target-file.ts
- automation/aws-account-preflight/src/target-schema.ts
- automation/aws-account-preflight/src/self-test.ts
- automation/aws-account-preflight/src/preflight-error.ts
- automation/aws-account-preflight/test/cli.test.ts
- automation/aws-account-preflight/test/target-file.test.ts
- automation/aws-account-preflight/test/preflight.test.ts
- automation/aws-account-preflight/test/test-support.ts
- automation/aws-account-preflight/test/fixtures/aws-stub.sh
- automation/aws-account-preflight/tsconfig.json
- automation/aws-account-preflight/jest.config.cjs
- automation/aws-account-preflight/README.md
- package.json
- tsconfig.json
- README.md
- docs/README.md
- docs/operations/README.md
- docs/operations/aws-cdk-deployment.md

Expected verification commands:
- npm run validate:aws-account-preflight
- npm run typecheck:automation
- npm run test:automation -- --runInBand
- npm run build
- npm test -- --runInBand
- npm run ci
- git diff --check
```
