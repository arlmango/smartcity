# SmartCity API image. Build from the repository root:
#   docker build -f infra/docker/api.Dockerfile -t smartcity-api:0.1.0 .
# Pinned: python 3.13.16 slim-bookworm, uv 0.11.32 (digests recorded 2026-10-18).
FROM ghcr.io/astral-sh/uv:0.11.32@sha256:df4cae8f3a96d175e2e5f992e597550000edbe78fdc2594d5cd8de1a217f504c AS uv

FROM python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv

COPY --from=uv /uv /usr/local/bin/uv

RUN groupadd --system --gid 10001 smartcity \
 && useradd --system --uid 10001 --gid smartcity --home-dir /app --shell /usr/sbin/nologin smartcity

WORKDIR /app

# Dependency layer: workspace metadata + lockfile only (the lock is used as-is: --frozen).
COPY pyproject.toml uv.lock ./
COPY services/api/pyproject.toml services/api/pyproject.toml
COPY services/ingest/pyproject.toml services/ingest/pyproject.toml
# Optional BuildKit secret `build_ca` (extra CA for TLS-intercepting proxies); never stored in a layer.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    uv sync --frozen --no-dev --package smartcity-api --no-install-workspace

# Application code.
COPY services/api services/api
COPY config config
COPY infra/docker/api-entrypoint.sh /usr/local/bin/api-entrypoint.sh
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    uv sync --frozen --no-dev --package smartcity-api \
 && chmod 0755 /usr/local/bin/api-entrypoint.sh \
 && mkdir -p /app/data \
 && chown -R smartcity:smartcity /app/data

ENV PATH="/app/.venv/bin:${PATH}" \
    DATA_DIR=/app/data \
    COVERAGE_CONFIG=/app/config/coverage.geojson

USER smartcity
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/api-entrypoint.sh"]
CMD ["uvicorn", "smartcity_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--no-server-header"]
