# Reusable Packages

Each immediate child of this directory is reusable logic with its own manifest,
build, tests, and public exports. Packages may be consumed by CDK apps and
automation, so they must not import deployable apps or operator workflows.

Packages accept explicit typed inputs and keep their dependency direction toward
other packages and external libraries. A package is introduced only when there
is a real shared capability or more than one concrete consumer.
