FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV KEY_DIR=/run/ssh-keys
ENV SSH_BIN=/usr/bin/ssh
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./server.js
COPY public ./public

RUN mkdir -p /app/data /run/ssh-keys \
 && chown -R node:node /app /run/ssh-keys

USER node
EXPOSE 9999
CMD ["node", "server.js"]
