FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=4173 ARENA_BIND=0.0.0.0 ARENA_DB=/data/arena.sqlite
VOLUME ["/data"]
EXPOSE 4173
CMD ["node", "server/http.cjs"]
