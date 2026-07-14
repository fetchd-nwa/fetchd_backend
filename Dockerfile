# NWA API — production image for Railway (and any Docker host).
# Two stages: build (devDeps + tsc → dist) then a slim runtime with prod deps
# only. Debian slim (not Alpine) because `sharp` ships glibc prebuilt binaries.

# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Lockfile-first so the dep layer caches across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# Reinstall prod-only deps so `sharp` resolves its linux-x64 binary for this
# stage and devDeps (typescript/tsx) stay out of the image.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Supabase's CA cert — DATABASE_SSL_CA points here (verified TLS, not disabled).
COPY certs ./certs
# Documentation only; Railway injects $PORT and the app listens on it.
EXPOSE 3000
CMD ["node", "dist/index.js"]
