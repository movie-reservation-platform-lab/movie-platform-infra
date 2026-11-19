# Required approved immutable inputs; use matching architecture and glibc bases.
# Build at the infra root after building both workspaces; no service source build.
ARG AWS_CLI_IMAGE
ARG NODE_IMAGE
FROM ${AWS_CLI_IMAGE} AS awscli
FROM ${NODE_IMAGE}
COPY --from=awscli /usr/local/aws-cli/ /usr/local/aws-cli/
RUN ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws && node --version && aws --version
WORKDIR /opt/trial
COPY automation/harness-buy-check/dist/ ./automation/harness-buy-check/dist/
COPY packages/experiment-sandbox/dist/ ./node_modules/@movie-platform/experiment-sandbox/dist/
COPY packages/experiment-sandbox/package.json ./node_modules/@movie-platform/experiment-sandbox/package.json
# The contract package's only runtime dependency; it has no dependencies of its own.
COPY node_modules/zod/ ./node_modules/zod/
RUN node automation/harness-buy-check/dist/main.js evaluate
USER 65532:65532
ENTRYPOINT ["node", "/opt/trial/automation/harness-buy-check/dist/main.js"]
