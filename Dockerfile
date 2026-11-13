# One image for the Node server; it also serves the built web app.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first (cached unless a package.json / lockfile changes).
COPY package.json package-lock.json ./
COPY packages/crdt/package.json packages/crdt/
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/server apps/server
COPY apps/web apps/web
RUN npm run build -w @crdt-editor/web

USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=2s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "apps/server/src/index.ts"]
