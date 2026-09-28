# Operational Automation

This directory contains independently tested commands and adapters used by
operators or CI. Examples include account preflight, guarded bootstrap, artifact
copying, cleanup readiness, and smoke orchestration.

Automation may consume reusable packages but must not import a deployable app.
When it needs to synthesize or invoke an app, it uses the app's documented command
boundary. This keeps AWS process execution, credential handling, and operational
sequencing out of CDK composition roots.

Not every historical directory here is an npm workspace yet. A tool gains a
manifest when it needs independent build/test commands or another workspace
dependency; the workspace validator discovers only children with `package.json`.
