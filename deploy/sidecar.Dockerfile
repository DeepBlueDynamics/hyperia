# syntax=docker/dockerfile:1.7
# hyperia-sidecar container (deploy spec: hyperia-docker-deployment-spec.md).
# BUILD CONTEXT MUST BE THE REPO ROOT — sidecar/Cargo.toml references sibling
# crates via `../lume`, `../aegis-edit`, `../grub-md` path deps.
#
#   docker build -f deploy/sidecar.Dockerfile -t deepbluedynamics/hyperia-sidecar:0.11.0 .

# ---- builder ----
FROM rust:1-bookworm AS build
WORKDIR /build
# Sibling crates the sidecar depends on via path deps. Layout must match
# the `../lume`, `../aegis-edit`, `../grub-md` references in sidecar/Cargo.toml.
COPY lume        ./lume
COPY aegis-edit  ./aegis-edit
COPY grub-md     ./grub-md
COPY sidecar     ./sidecar
WORKDIR /build/sidecar
# --locked uses the committed Cargo.lock for reproducible builds.
RUN cargo build --release --locked
RUN strip target/release/hyperia-sidecar || true

# ---- runtime ----
FROM debian:bookworm-slim AS runtime
# rustls TLS — no OpenSSL needed; ca-certificates for outbound HTTPS,
# wget for the healthcheck.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*
# Non-root runtime user with a real HOME for ~/.hyperia state.
RUN useradd --create-home --uid 10001 app
WORKDIR /app
COPY --from=build /build/sidecar/target/release/hyperia-sidecar /usr/local/bin/hyperia-sidecar
# NOTE: sidecar/static + sidecar/assets are NOT copied — verified embedded at
# compile time (assets/hyperia-mcp.py via include_str!; nothing reads either
# dir from disk at runtime; ~/.hyperia/assets is runtime state on the volume).
USER app
ENV HOME=/home/app \
    HYPERIA_BIND=0.0.0.0 \
    FERRICULA_URL=http://ferricula:8765 \
    RUST_LOG=info
EXPOSE 9800
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:9800/health || exit 1
ENTRYPOINT ["hyperia-sidecar"]
CMD ["--port", "9800"]
