# The API server image. The DB-IP City Lite database must be at geoip/dbip-city-lite.mmdb (the release workflow
# downloads it; see "Deploy" in README.md). BUILD_IMAGE lets a build behind a TLS-inspecting proxy use a Node
# image that trusts the proxy's certificate; the image that runs is always the official one.
ARG BUILD_IMAGE=node:24.21.0-trixie-slim

FROM ${BUILD_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src src
RUN npm run build && npm prune --omit=dev

FROM node:24.21.0-trixie-slim
ENV NODE_ENV=production GEOIP_DB=/app/geoip/dbip-city-lite.mmdb
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY drizzle drizzle
COPY geoip/dbip-city-lite.mmdb geoip/
USER node
EXPOSE 47110
CMD ["node", "dist/index.js"]
