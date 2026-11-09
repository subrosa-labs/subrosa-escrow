# Backend image. Build from the repository root:
#
#   docker build -t subrosa-relayer .
#
# The relayer needs no build tooling at runtime, so the final image carries only
# production dependencies and the compiled output.

FROM node:22-alpine AS build
WORKDIR /app

# Copy only the manifests first so dependency installation is cached independently
# of source edits. All three manifests are needed because npm resolves the lock
# file for the whole workspace tree.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json

RUN npm ci --workspace backend --include-workspace-root

COPY backend ./backend

RUN npm run build --workspace backend

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json

RUN npm ci --omit=dev --workspace backend --include-workspace-root \
  && npm cache clean --force

COPY --from=build /app/backend/dist ./backend/dist

# Run unprivileged. The image intentionally contains no .env: configuration is
# supplied at runtime (compose `env_file`, `docker run --env-file`, or a secret
# store). See backend/.env.example.
USER node

EXPOSE 8080

# The image has no curl/wget by default; Node itself is the health probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/dist/index.js"]
