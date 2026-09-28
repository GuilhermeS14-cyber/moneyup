FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js index.html schema.sql ./
ENV NODE_ENV=production PORT=4173
USER node
EXPOSE 4173
CMD ["node", "server.js"]
