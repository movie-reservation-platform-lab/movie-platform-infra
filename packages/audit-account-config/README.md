# Audit Account Configuration

This package is the shared runtime contract for the dedicated audit topology.
Both the CDK composition root and operator automation consume the same validated
management-account, audit-account, workload-account, and Region selection.

TypeScript types protect callers only after parsing. The parser treats JSON as
untrusted runtime input, rejects ambiguous account roles, and returns the narrow
typed value exposed through the package root.
