# Implementation Plan: Prefix List Ingress Allowlist

> Status: active design and implementation review for issue
> [#3](https://github.com/movie-reservation-platform-lab/movie-platform-infra/issues/3).
> The branch implementation is staged but has not been deployed or delivered.

Last reviewed: 2026-08-05

## 1. Summary

Replace the changing `allowedIngressCidr` CDK context value with the ID of one
stable, externally owned customer-managed IPv4 prefix list. Reference that list
from both the public Application Load Balancer security group and Amazon Managed
Grafana network access control.

Operators can then add, remove, or rotate trusted public `/32` entries without
running `cdk deploy`. The CDK app continues to validate inputs and synthesize
offline, while AWS-side preflight and the deployment runbook validate properties
that cannot be proven from an ID string.

This is an infrastructure, deployment-contract, and security-boundary change.
It is a standard plan: the code change is small, but its external ownership and
rollout behavior need to be explicit.

## 2. Goals

- Make the ingress allowlist a stable deployment input rather than a changing
  developer CIDR.
- Allow trusted public `/32` entries to change without a CloudFormation update.
- Apply the same allowlist to ALB HTTP ingress and Managed Grafana network
  access.
- Keep public CI synthesis credential-free, offline, and deterministic.
- Validate untrusted CDK context once before constructing the stack.
- Make prefix-list ownership, mutation, verification, and teardown boundaries
  explicit in repository documentation.
- Preserve the existing ECS, VPC, ALB listener, Grafana authentication, IAM,
  observability, and application-image behavior.

## 3. Non-goals

- Do not create or populate the ingress prefix list in
  `GoldenPathDemoStack`.
- Do not add S3, DynamoDB, Parameter Store, Lambda, or a custom resource as an
  indirection layer for CIDR entries.
- Do not perform AWS lookups during synth or public CI.
- Do not automate public-IP discovery or mutate access controls from CI.
- Do not introduce separate ALB and Grafana allowlists until their audiences or
  ownership requirements diverge.
- Do not add TLS, WAF, VPN access, Grafana VPC endpoints, or production account
  controls in this issue.
- Do not deploy, destroy, or mutate AWS resources as part of implementation.

## 4. Current State

### State before this branch

`bin/infra.ts` read `allowedIngressCidr` from CDK context.
`lib/config/platform-config.ts` required a string and explicitly rejected
`0.0.0.0/0`.

`lib/infra-stack.ts` used the CIDR in two different resource lifecycles:

1. `ec2.Peer.ipv4(...)` emitted a CIDR-based ingress rule for TCP port `80` on
   the ALB security group.
2. `ec2.CfnPrefixList` created a stack-owned, one-entry prefix list for Managed
   Grafana, and the Grafana workspace referenced its generated ID.

A developer IP change therefore required a new context value and stack deploy.
The same logical access policy was represented differently for the ALB and
Grafana.

### State in the staged branch

- `bin/infra.ts` reads `allowedIngressPrefixListId`.
- `PlatformConfigContext` accepts that external value as `unknown` and
  `resolvePlatformConfig` trims and validates it before producing
  `PlatformConfig`.
- `ec2.Peer.prefixList(...)` emits an `AWS::EC2::SecurityGroupIngress` resource
  with `SourcePrefixListId` for ALB TCP port `80`.
- `grafana.CfnWorkspace.networkAccessControl.prefixListIds` receives the same
  literal ID.
- The stack no longer synthesizes an `AWS::EC2::PrefixList`.
- `test/infra.test.ts` asserts both consumer references, malformed input
  rejection, trimming, and the absence of a stack-owned prefix list.
- `package.json` uses a syntactically valid fake prefix-list ID for the offline
  ECR synth contract.
- The root README plus `docs/architecture/` and `docs/operations/` describe the
  external prerequisite and operator workflow.

### Validation layers

- TypeScript checks that internal code receives a `string`, but interfaces are
  erased at runtime.
- `resolvePlatformConfig` performs runtime syntax validation without AWS
  credentials.
- CDK emits the CloudFormation properties but does not prove that the list
  exists or is suitable.
- An authenticated AWS preflight must verify target account, Region, owner,
  address family, state, maximum size, and entries before deploy.

## 5. Requirements and Assumptions

### Confirmed Requirements

- Replace `allowedIngressCidr` with a validated prefix-list ID context value.
- Use the configured list for public ALB ingress.
- Use the same list for Managed Grafana network access.
- Update CDK assertion tests and documentation.
- Keep public CI synth offline and deterministic.
- Create and maintain prefix-list entries manually outside this stack.

### Assumptions

- The list is a customer-managed IPv4 prefix list owned by the target account
  in the target Region.
- Entries are trusted public `/32` CIDRs. Private ranges do not provide the
  intended public Grafana access, and `0.0.0.0/0` is prohibited by operator
  policy.
- `maxEntries=10` is enough for this disposable demo and intentionally bounds
  both access growth and security-group quota consumption.
- The same operators and source networks currently need network reachability to
  the ALB and Grafana.
- Grafana still requires IAM Identity Center authentication and authorization;
  the prefix list is an additional network gate, not user authentication.
- Breaking the old context key is acceptable because this is a disposable lab
  stack with no stable external deployment API.

### Open Questions

- Which IAM role is authorized to create and modify the shared prefix list in a
  real lab account?
- Is CloudTrail review sufficient for entry-change audit, or should a later
  environment-control workflow require pull-request approval?
- Has a real target account been selected for the first migration proof?

These questions do not block offline implementation. They must be answered
before a real deployment.

## 6. Proposed Design

### External lifecycle boundary

Treat the prefix list as an account/Region prerequisite, similar to the CDK
bootstrap and IAM Identity Center setup. `GoldenPathDemoStack` consumes its ID
but does not own its creation, entries, or deletion.

This boundary is intentional. Prefix-list versions change when entries change,
and AWS resources referencing the list use its current version. Keeping entries
outside CloudFormation gives operators the requested fast rotation behavior and
prevents a later `cdk deploy` from restoring an old list of CIDRs.

### Configuration boundary

Read the raw context only in `bin/infra.ts`. Keep its type as `unknown` in
`PlatformConfigContext`, then narrow, trim, and validate it in
`resolvePlatformConfig`.

Accept only lowercase EC2 prefix-list IDs with exactly the legacy 8-character
or current 17-character hexadecimal suffix:

```text
^pl-(?:[0-9a-f]{8}|[0-9a-f]{17})$
```

The exact alternatives reject nonexistent intermediate resource-ID lengths and
uppercase characters. Syntax validation deliberately does not call AWS.

### CDK consumers

Use `ec2.Peer.prefixList(id)` for the ALB security-group ingress rule. This does
not look up or import the EC2 resource; it supplies `SourcePrefixListId` in the
synthesized CloudFormation rule.

Pass the same ID to the L1 `grafana.CfnWorkspace` network access configuration.
Keep `vpceIds: []` explicit so Grafana admits public requests only when their
source is in the configured list. IAM Identity Center remains the user-level
access boundary.

### Operator preflight

Before `cdk diff` or `cdk deploy`, use `describe-managed-prefix-lists` and
`get-managed-prefix-list-entries` against the explicit ID. Verify:

- caller account and target Region;
- `OwnerId` equals the intended account;
- `AddressFamily` is `IPv4`;
- `State` is usable;
- `MaxEntries` remains small enough for the ALB security-group quota;
- entries contain only reviewed public `/32` CIDRs;
- at least the deploying operator's current source address is present.

This live check belongs in the runbook or a future explicit preflight script,
not CDK synthesis.

### Documentation ownership

- Root `README.md`: quick-start context and short prefix-list commands.
- `docs/operations/aws-cdk-deployment.md`: authoritative setup, preflight,
  migration, rollback, and teardown runbook.
- `docs/architecture/aws-resource-topology.md`: durable external ownership and
  shared-consumer decision.
- This plan: issue-level implementation and review history. Move it to
  `docs/plans/delivered/` after the change lands.

## 7. Alternatives Considered

### Alternative A: Continue passing a literal CIDR to CDK

- Pros: simplest resource graph; CloudFormation owns every access rule.
- Cons: every IP rotation requires new context, synth, diff, and deployment;
  ALB and Grafana represent the same policy differently.
- Decision: rejected because it does not meet the operating goal.

### Alternative B: Keep a stack-owned prefix list and manage entries in CDK

- Pros: prefix list and entries stay reviewable as infrastructure code; teardown
  remains completely stack-owned.
- Cons: routine entry changes still require deployment; manual edits become
  CloudFormation drift and can be overwritten on a later deploy.
- Decision: rejected for this demo workflow. Reconsider for controlled
  production environments where change approval matters more than workstation
  mobility.

### Alternative C: Store CIDRs in a config service and synchronize with a custom resource

- Pros: could centralize desired entries and keep deployment inputs stable.
- Cons: adds storage, IAM, Lambda/custom-resource failure modes, and indirect
  ownership even though ALB and Grafana already consume prefix lists directly.
- Decision: rejected as unnecessary platform machinery.

### Alternative D: Use separate prefix lists for ALB and Grafana

- Pros: stronger least-privilege separation and independent operator/audience
  lifecycles.
- Cons: doubles manual prerequisites and routine entry maintenance while both
  surfaces currently serve the same trusted developers.
- Decision: defer until the audiences or security classifications diverge.

## 8. API / Interface Changes

- Remove CDK context key `allowedIngressCidr`.
- Add required CDK context key `allowedIngressPrefixListId`.
- Rename `PlatformConfigContext.allowedIngressCidr` and
  `PlatformConfig.allowedIngressCidr` accordingly.
- The value changes from an IPv4 CIDR to an EC2 prefix-list resource ID.
- `npm run synth:ecr-contract` and every documented CDK command must supply the
  new key.
- The synthesized ALB ingress changes from `CidrIp` to `SourcePrefixListId`.
- The Grafana workspace changes from a `Fn::GetAtt` of a stack-owned prefix list
  to the externally supplied ID.

No application API, container, database, event, or telemetry schema changes.

## 9. Data Model / Persistence Changes

No application persistence changes.

The external EC2 prefix list is mutable AWS control-plane state. Its entries and
versions persist independently of `GoldenPathDemoStack`, and stack teardown must
not delete it. Entry restoration uses the EC2 prefix-list version history rather
than an application migration or database rollback.

## 10. Security, Privacy, and Abuse Considerations

- A prefix-list edit changes reachability to both public surfaces immediately
  and bypasses CloudFormation review. Restrict `ec2:ModifyManagedPrefixList` and
  related permissions to an explicit operator role.
- Never add `0.0.0.0/0`. The CDK app cannot inspect external entries during
  offline synth, so this is enforced by permissions, preflight, review, and
  audit rather than TypeScript.
- Sharing one list couples the ALB and Grafana network audiences. Grafana still
  requires Identity Center authentication, but network reachability is broader
  than user authorization.
- The ALB still listens on HTTP port `80`. The prefix list reduces source
  exposure but does not provide encryption. TLS is a separate design slice.
- Use public `/32` entries for developer laptops. Amazon Managed Grafana ignores
  private ranges for public IP filtering.
- Tag the external list with project, environment, owner, and purpose so an
  operator can distinguish it from unrelated or AWS-managed lists.
- CloudTrail should remain the audit source for create, modify, restore, and
  delete calls until a controlled environment workflow is introduced.

## 11. Performance, Scalability, and Reliability Considerations

- A security-group rule referencing a customer-managed prefix list consumes
  rule quota equal to the list's configured maximum size, not its current entry
  count. `maxEntries=10` therefore consumes ten inbound-rule slots on the ALB
  security group.
- Do not raise `MaxEntries` casually. Check the account's security-group quotas
  first.
- Prefix-list entry changes create a new version and referenced resources use
  the current version. This removes deployment latency from IP rotation but
  introduces an externally mutable dependency.
- A missing, wrong-Region, inaccessible, IPv6, or unsuitable list causes live
  deployment or access failure even though offline synth succeeds.
- An empty list intentionally locks out both ALB and Grafana public access.
- One list is sufficient for current scale. Grafana supports multiple lists if
  future independent audiences require them.
- No request-path service, cache, database, retry loop, or background worker is
  introduced.

## 12. Implementation Steps

1. Tighten the typed configuration boundary
   - Change: replace the CIDR context field with a required prefix-list ID and
     validate exactly 8- or 17-character lowercase EC2 ID suffixes.
   - Files/modules likely affected: `bin/infra.ts`,
     `lib/config/platform-config.ts`.
   - Notes: keep raw input typed as `unknown`; do not add AWS lookups.
   - Verification: unit tests for missing, malformed, intermediate-length,
     uppercase, trimmed, legacy-length, and current-length IDs.

2. Reference the external list from both public surfaces
   - Change: use `ec2.Peer.prefixList` for ALB TCP `80`, remove the stack-owned
     Grafana prefix list, and pass the external ID to Grafana network access.
   - Files/modules likely affected: `lib/infra-stack.ts`.
   - Notes: retain Identity Center authentication and all unrelated topology.
   - Verification: CDK assertions for `SourcePrefixListId`, Grafana
     `PrefixListIds`, and zero `AWS::EC2::PrefixList` resources.

3. Preserve the offline synth contract
   - Change: replace the fake CIDR with a fake syntactically valid prefix-list
     ID.
   - Files/modules likely affected: `package.json`.
   - Notes: retain `--no-lookups` and fake AWS account/image values.
   - Verification: `npm run synth:ecr-contract` without AWS credentials.

4. Document the external lifecycle and live preflight
   - Change: explain creation, tagging, inspection by explicit ID, entry add and
     removal, version restoration, quota weight, migration, and independent
     cleanup.
   - Files/modules likely affected: `README.md`,
     `docs/operations/aws-cdk-deployment.md`,
     `docs/architecture/aws-resource-topology.md`.
   - Notes: avoid claiming that offline CDK validation proves ownership or
     address family.
   - Verification: inspect commands and links; run shell syntax checks only if
     commands move into an executable script.

5. Review the CloudFormation migration
   - Change: confirm the diff removes the old stack-owned Grafana prefix list,
     replaces CIDR ingress with prefix-list ingress, and updates Grafana to the
     external ID.
   - Files/modules likely affected: synthesized template only; do not commit
     `cdk.out/`.
   - Notes: create and populate the external list before deployment.
   - Verification: `npm run cdk -- diff ...` against the real target stack.

6. Deliver and archive the plan
   - Change: after the issue or pull request lands, add a delivered banner and
     move this file to `docs/plans/delivered/`.
   - Files/modules likely affected: this plan and
     `docs/plans/delivered/README.md`.
   - Notes: keep durable truth in architecture and operations docs.
   - Verification: check documentation links after the move.

## 13. Testing Strategy

- TypeScript build: prove renamed configuration properties are propagated
  through entrypoint, resolver, stack props, and tests.
- Runtime validation tests: cover missing values, wrong resource prefixes,
  CIDRs, invalid hex, 9- through 16-character suffixes, uppercase, whitespace,
  legacy 8-character IDs, and current 17-character IDs.
- CDK assertion tests: prove exact ALB protocol/port/source and Grafana network
  access properties.
- Resource lifecycle assertion: prove no `AWS::EC2::PrefixList` remains in the
  synthesized stack.
- Regression tests: retain existing VPC, ECS, IAM, observability, image, and
  optional ECS Exec coverage.
- Offline contract: run `npm run synth:ecr-contract` with `--no-lookups`.
- Real deployment proof: after explicit approval, verify ALB access and Grafana
  access from an included `/32`, then verify an unlisted source is denied.
- Operational mutation proof: add or rotate a test `/32`, verify access changes
  without stack deployment, then remove or restore the prior prefix-list
  version.

Expected local verification:

```bash
npm run build
npm test -- --runInBand
npm run synth:ecr-contract
```

## 14. Rollout / Migration Plan

1. Create and tag the external customer-managed IPv4 prefix list in the target
   account and Region.
2. Add the currently trusted public `/32` before changing the stack.
3. Verify owner, family, state, maximum entries, current version, and entries by
   explicit prefix-list ID.
4. Run the full local checks and offline synth contract.
5. Run `cdk diff` with the new context and explicitly review deletion of the old
   Grafana prefix list plus replacement of the ALB ingress rule.
6. Deploy only with explicit operator approval.
7. Verify ALB and Grafana reachability from an included address. Confirm Grafana
   still requires Identity Center authorization.
8. Verify the prefix list is not owned by the CloudFormation stack and survives
   stack teardown.

If an entry edit causes lockout, restore the prior prefix-list version or add
the trusted `/32` from a separately authorized session. If the stack deployment
fails, allow CloudFormation rollback to complete. If the new design must be
reverted after deployment, deploy the prior code with `allowedIngressCidr`,
verify both surfaces, then delete the external prefix list only after it has no
remaining associations.

## 15. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
| --- | ---: | ---: | --- |
| Wrong or empty external list locks out ALB and Grafana | High | Medium | Preflight explicit ID and entries; populate current `/32` before deploy; retain prefix-list version rollback knowledge |
| Broad entry exposes both public surfaces | High | Medium | Restrict mutation IAM; prohibit `0.0.0.0/0`; review entries; audit through CloudTrail |
| Current regex accepts invalid intermediate ID lengths | Medium | High | Tighten to exact 8 or 17 lowercase hex characters and add table-driven tests |
| Large `MaxEntries` exhausts ALB security-group quota | High | Low | Keep maximum at 10; document quota weight; inspect quotas before resizing |
| Shared list becomes an inappropriate coupled trust boundary | Medium | Medium | Split ALB and Grafana configuration when audiences or owners diverge |
| External manual state drifts from documentation | Medium | Medium | Tag the list; add live preflight; keep an explicit operator owner and audit trail |
| CloudFormation migration removes old Grafana prefix list before access is proven | High | Low | Create and validate external list first; review diff; verify immediately; keep rollback steps |
| Offline synth gives false confidence about live AWS state | Medium | High | State validation limits clearly; require authenticated preflight before deploy |

## 16. Done Criteria

- `allowedIngressCidr` is absent from active code, tests, package scripts, and
  current runbooks.
- The config boundary rejects missing and malformed prefix-list IDs, including
  intermediate lengths and uppercase forms.
- The ALB rule synthesizes `SourcePrefixListId` for TCP port `80`.
- Managed Grafana references the same configured list and retains Identity
  Center authentication.
- The stack synthesizes no `AWS::EC2::PrefixList`.
- Build, all Jest tests, and offline synth contract pass.
- Operations documentation covers ownership, preflight, entry removal,
  restoration, quota weight, migration, rollback, and external cleanup.
- No AWS lookup is introduced during synth.
- A real deployment is performed only after account, Region, IAM owner, prefix
  list, expected cost, and teardown are explicitly approved.
- After delivery, durable facts remain in architecture/operations docs and this
  plan moves to `docs/plans/delivered/`.

## 17. Review Checklist

- [x] Requirements are explicit
- [x] Non-goals are explicit
- [x] Existing code conventions were checked
- [x] Alternatives were considered
- [x] Security implications were reviewed
- [x] Scalability and reliability implications were reviewed
- [x] Testing strategy is complete
- [x] Rollout and rollback are defined
- [x] Implementation steps are ordered and concrete
- [x] Prefix-list ID validation is tightened
- [x] AWS-side preflight is documented
- [ ] Real target account ownership is confirmed before deployment

## 18. Handoff Prompt for Implementation Agent

```text
Implement the remaining work in docs/plans/prefix-list-ingress-allowlist.md.

Constraints:
- Stay within the scope of the plan and issue #3.
- Do not introduce new dependencies, AWS lookups, or config-store indirection.
- Preserve existing ECS, VPC, IAM, observability, and application-image behavior.
- Treat the customer-managed prefix list as an external account/Region prerequisite.
- Do not deploy, destroy, create, or modify AWS resources without explicit user approval.
- Work with the currently staged branch and docs; do not revert existing changes.
- If implementation reality differs from the plan, update the plan or ask for approval before changing scope.

Relevant files/modules:
- bin/infra.ts
- lib/config/platform-config.ts
- lib/infra-stack.ts
- test/infra.test.ts
- package.json
- README.md
- docs/architecture/aws-resource-topology.md
- docs/operations/aws-cdk-deployment.md

Expected verification commands:
- npm run build
- npm test -- --runInBand
- npm run synth:ecr-contract
```
