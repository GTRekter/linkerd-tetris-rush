# Build context: repo root
FROM node:20-slim
WORKDIR /app
COPY api/agent/package.json ./
RUN npm install --omit=dev
COPY api/agent/index.js ./
EXPOSE 80
CMD ["node", "index.js"]
