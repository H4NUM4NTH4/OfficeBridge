FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm
COPY src ./src
RUN mkdir -p /app/data /app/storage && chown node:node /app/data /app/storage
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
