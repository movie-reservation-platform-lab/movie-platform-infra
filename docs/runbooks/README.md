# On-Call Runbooks

One runbook per paging alarm family. Every alarm description links here, so an
on-call engineer receiving a page lands on the cause, severity, and first
response. Deployment, teardown, and other planned operator work lives in
[operations](../operations/README.md).

- [Audit Publish Alarms](./audit-publish-alarms.md): workload-account alarms for
  audit events the reservation service could not publish, including unaudited
  successful logins.
- [Audit Delivery Alarms](./audit-delivery-alarms.md): audit-account alarms for
  events the central bus accepted but EventBridge, the DLQ, or Firehose did not
  deliver to Security Lake.
