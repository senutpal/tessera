# Multi-stage production container build for Tessera Monorepo
# Base stage with Node.js 20 Alpine and pnpm package manager
FROM node:20-alpine AS base
ARG PNPM_VERSION=10.15.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# Dependencies stage: Install monorepo dependencies
FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json biome.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/event-bus/package.json ./packages/event-bus/
COPY packages/mandates/package.json ./packages/mandates/
COPY packages/paypal/package.json ./packages/paypal/
COPY packages/channel3/package.json ./packages/channel3/
COPY packages/policy/package.json ./packages/policy/
COPY packages/mcp-server/package.json ./packages/mcp-server/
COPY apps/clearinghouse-api/package.json ./apps/clearinghouse-api/
COPY apps/clearinghouse-ui/package.json ./apps/clearinghouse-ui/

RUN pnpm install --frozen-lockfile

# Builder stage: Compile TypeScript packages and bundle frontend assets
FROM dependencies AS builder
COPY packages ./packages
COPY apps ./apps

RUN pnpm -r run build

# Production dependencies stage: Prune devDependencies to keep footprint < 180MB
FROM builder AS prod-dependencies
RUN pnpm prune --prod

# Runner stage: Lightweight production execution image (< 180MB footprint)
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Security: Run as dedicated non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 tessera

# Copy necessary production assets and build outputs
COPY --from=prod-dependencies /app/node_modules ./node_modules
COPY --from=prod-dependencies /app/package.json ./package.json
COPY --from=prod-dependencies /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/clearinghouse-api ./apps/clearinghouse-api

USER tessera
EXPOSE 3000

CMD ["node", "apps/clearinghouse-api/dist/server.js"]

# Dashboard stage: High-performance static web server for AG Grid Enterprise UI
FROM nginx:alpine AS dashboard
COPY --from=builder /app/apps/clearinghouse-ui/dist /usr/share/nginx/html
RUN echo 'server { \
    listen 80; \
    location / { \
        root /usr/share/nginx/html; \
        index index.html index.htm; \
        try_files $uri $uri/ /index.html; \
    } \
    location /api/ { \
        proxy_pass http://tessera-api:3000/; \
        proxy_set_header Host $host; \
        proxy_set_header X-Real-IP $remote_addr; \
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; \
        proxy_set_header X-Forwarded-Proto $scheme; \
    } \
    location /ws/ { \
        proxy_pass http://tessera-api:3000; \
        proxy_http_version 1.1; \
        proxy_set_header Upgrade $http_upgrade; \
        proxy_set_header Connection "upgrade"; \
        proxy_set_header Host $host; \
        proxy_set_header X-Real-IP $remote_addr; \
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; \
    } \
    error_page 500 502 503 504 /50x.html; \
    location = /50x.html { \
        root /usr/share/nginx/html; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
