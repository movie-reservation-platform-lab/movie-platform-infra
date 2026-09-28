# Deployable Applications

Each immediate child of this directory is an independently buildable and
synthesizable CDK composition root. An app chooses concrete accounts, Regions,
stack boundaries, and infrastructure policy by consuming reusable packages.

Apps may depend on `packages/*`. They must not import another app or operational
code from `automation/*`. Cross-account sequencing and guarded live commands
belong in automation, while reusable validation and construct logic belong in a
package.
