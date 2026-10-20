# multiple-gmail server mode. See DEPLOY.md.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
# Single-file bundle: build/main.cjs (all dependencies inlined). The wizard files stay in src/web.
RUN node scripts/build-exe.mjs --bundle-only

FROM node:24-slim
ENV NODE_ENV=production \
    MULTIPLE_GMAIL_HOME=/data \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
COPY --from=build /app/build/main.cjs ./build/main.cjs
COPY --from=build /app/src/web ./src/web
# The node image ships an unprivileged "node" user; the data volume belongs to it.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
VOLUME /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "build/main.cjs", "serve", "--remote"]
