# SmartCity web (Next.js standalone). Build from the repository root:
#   docker build -f infra/docker/web.Dockerfile -t smartcity-web:0.1.0 .
# Behind a TLS-intercepting proxy (optional): pass HTTPS_PROXY as a build arg and the CA as a
# BuildKit secret, e.g. --network host --build-arg HTTPS_PROXY=$HTTPS_PROXY --secret id=npm_ca,src=/path/ca.crt
# (the secret is never stored in an image layer).
# Runtime: API_INTERNAL_URL (default http://api:8000) is read per request by the
# /api/* route-handler proxy, so the same image works with any API address.

ARG NODE_IMAGE=node:22.22.0-slim

# ---------------------------------------------------------------- deps
FROM ${NODE_IMAGE} AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY apps/web/package.json apps/web/pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm_config_cafile=/run/secrets/npm_ca; fi; \
    corepack enable && corepack prepare pnpm@10.28.0 --activate \
    && pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
ENV CI=1 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/web/ ./
RUN node node_modules/next/dist/bin/next build

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 API_INTERNAL_URL=http://api:8000
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
