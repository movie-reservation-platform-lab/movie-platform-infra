# Official Tempo 2.10 patch release; immutable multi-architecture manifest.
FROM busybox:1.37.0-musl@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23 AS healthcheck
FROM grafana/tempo:2.10.8@sha256:f0561deb1c68ec44d6e6e7e4487f30106c4e5e768642077695b37958b105812a
COPY --from=healthcheck /bin/busybox /busybox
COPY --chown=10001:10001 tempo.yaml /etc/tempo.yaml
CMD ["-config.file=/etc/tempo.yaml", "-target=all", "-config.expand-env=true"]
