# Hosted build (matteblack.app). Local/desktop builds never use this file.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
# Electron is a devDependency; skip its 100MB binary in the server image.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci
COPY . .
RUN npx vite build && npm run build:server

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production LOCAL_MODE=false ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/public ./public
EXPOSE 3001
CMD ["node", "dist-server/index.js"]
