# --- BUILD STAGE ---
FROM node:22-alpine AS builder
WORKDIR /app

# Copy workspace root manifests
COPY package*.json ./
COPY apps/cloud/package*.json ./apps/cloud/
COPY packages/core/package*.json ./packages/core/

# Install all workspace dependencies
RUN npm ci

# Copy source code
COPY packages/core ./packages/core
COPY apps/cloud ./apps/cloud

# Build Core SDK
WORKDIR /app
RUN npm run build -w @jevshield/core

# Generate Prisma client and build Cloud Gateway
WORKDIR /app/apps/cloud
RUN npx prisma generate
RUN npm run build

# --- PRODUCTION STAGE ---
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

# Copy workspace manifests
COPY package*.json ./
COPY apps/cloud/package*.json ./apps/cloud/
COPY packages/core/package*.json ./packages/core/

# Install production dependencies only
RUN npm ci --omit=dev -w @jevshield/core
RUN npm ci --omit=dev -w @jevshield/cloud

# Copy built artifacts
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/apps/cloud/dist ./apps/cloud/dist
COPY --from=builder /app/apps/cloud/node_modules/.prisma ./apps/cloud/node_modules/.prisma
COPY --from=builder /app/apps/cloud/prisma ./apps/cloud/prisma

EXPOSE 4000

WORKDIR /app/apps/cloud

CMD ["node", "dist/index.js"]
