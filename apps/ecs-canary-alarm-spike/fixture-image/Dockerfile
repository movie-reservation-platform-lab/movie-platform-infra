# Spike fixture for infra#100. Repository-owned like adot-collector/, not
# application source. Build one image per VARIANT; each gets its own digest.
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f

ARG VARIANT
RUN test -n "$VARIANT"
ENV SPIKE_VARIANT=$VARIANT \
    PORT=8080 \
    NODE_ENV=production

WORKDIR /app
COPY responses.cjs server.cjs ./
USER node
EXPOSE 8080
CMD ["node", "server.cjs"]
