# Multi-stage build for React frontend

# Stage 1: Build the React app
# Note: Vite 7.x requires Node.js 20.19+ or 22.12+
FROM node:26-alpine AS builder

# Build argument for app version (passed from parent package.json)
ARG APP_VERSION=0.0.0

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the app with version injected via environment variable
RUN VITE_APP_VERSION=${APP_VERSION} npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine

# Install envsubst for runtime config injection
RUN apk add --no-cache gettext

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy runtime config template
COPY public/config.js.template /usr/share/nginx/html/config.js.template

# Copy custom nginx config for SPA routing
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy and make entrypoint script executable
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose port 8080
EXPOSE 8080

# Use entrypoint script to inject runtime config
ENTRYPOINT ["/entrypoint.sh"]
