# Official stable release verified 2026-09-07. Keep the immutable digest on updates.
FROM public.ecr.aws/aws-observability/aws-for-fluent-bit:2.34.3.20260901@sha256:e6b6b5c03c7912d10757e721641046db83c80ac05796dfbdb2c16cabf7b9a331

COPY platform.conf parsers.conf routing.conf route.lua /fluent-bit/platform/
# FireLens mounts its generated file at /fluent-bit/etc/fluent-bit.conf. We own
# the full config to set filesystem buffering on the actual forward input.
CMD ["/fluent-bit/bin/fluent-bit", "-c", "/fluent-bit/platform/platform.conf"]
