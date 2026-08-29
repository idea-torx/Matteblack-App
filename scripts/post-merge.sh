#!/usr/bin/env bash
set -e

echo "=== Post-merge setup ==="

echo "Installing dependencies..."
npm install --prefer-offline --no-audit --no-fund < /dev/null

echo "Rebuilding server bundle..."
npm run build:server < /dev/null

echo "Post-merge setup complete."
