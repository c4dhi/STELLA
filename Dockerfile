# Multi-stage build for session-management-server
FROM node:26-slim AS builder

WORKDIR /app

# Configure npm for better network reliability
RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-timeout 300000

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Generate Prisma client (needed for TypeScript compilation)
RUN npx prisma generate

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Compile prisma seed script separately (NestJS only builds src/, not prisma/)
# This ensures the seed runs reliably in Node.js 20 ESM mode
RUN npx tsc prisma/seed.ts --outDir dist/prisma --esModuleInterop --resolveJsonModule --module nodenext --moduleResolution nodenext --target ES2023 --skipLibCheck

# Production stage
FROM node:26-slim

WORKDIR /app

# Install kubectl for Kubernetes operations and Docker CLI for building agent images
RUN apt-get update && \
    apt-get install -y curl ca-certificates gnupg && \
    # Install kubectl
    curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/arm64/kubectl" && \
    install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl && \
    rm kubectl && \
    # Install Docker CLI (not the daemon, just the client)
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc && \
    chmod a+r /etc/apt/keyrings/docker.asc && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    apt-get update && \
    apt-get install -y docker-ce-cli && \
    # Cleanup
    apt-get remove -y curl gnupg && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# Configure npm for better network reliability
RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-timeout 300000

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Copy compiled seed script (compiled in builder stage)
COPY --from=builder /app/dist/prisma/seed.js ./prisma/seed.js

# Copy proto files for gRPC client (STT service)
# Proto is expected at dist/proto relative to dist/src/main.js (__dirname/../proto)
COPY --from=builder /app/proto ./dist/proto

# Cache buster for Prisma schema changes - this ARG invalidates the cache
# when the schema changes, ensuring prisma generate runs with the new schema
ARG PRISMA_SCHEMA_CHECKSUM=default
RUN echo "Schema checksum: ${PRISMA_SCHEMA_CHECKSUM}" && npx prisma generate

# Expose port
EXPOSE 3000

# Start the application
# Note: Migrations are now handled by K8s init container (run-migrations)
# for better failure visibility and separation of concerns
CMD ["node", "dist/src/main"]
