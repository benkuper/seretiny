FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 peut avoir besoin d'une compilation native si le binaire précompilé est indisponible.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data BODY_SIZE_LIMIT=120M
WORKDIR /app
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "build"]
