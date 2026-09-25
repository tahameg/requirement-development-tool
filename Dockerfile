# Multi-stage Dockerfile for HLR Writing Tool
# Provides containerized building, testing, and packaging (AppImage, deb, unpacked)

FROM node:20-bookworm AS builder

# Install system dependencies required for native compilation (better-sqlite3)
# and Linux desktop runtime libraries for Electron and AppImage packaging
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    libsqlite3-dev \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libgl1-mesa-dri \
    xvfb \
    fuse \
    file \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cache package installation
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm run setup:desktop

# Copy application sources and build configurations
COPY . .

# Compile TypeScript, bundle preload, and build Vite React frontend
RUN npm run build

# Run unit test suite
RUN npm test

# Default command: build Linux distribution packages including AppImage
CMD ["npm", "run", "package:appimage"]
