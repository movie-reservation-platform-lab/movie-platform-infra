# Verified 2026-07-18 against the official ADOT v0.48.0 release and Public ECR.
# Keep both the human-readable release tag and immutable multi-architecture digest.
FROM public.ecr.aws/aws-observability/aws-otel-collector:v0.48.0@sha256:9b28046359054b414f4ba76056ba4e8cffda2d53fbcee06171d7eeecd71326c3

COPY --chown=aoc:aoc adot-config.yaml /etc/adot/adot-config.yaml

CMD ["--config=/etc/adot/adot-config.yaml"]
