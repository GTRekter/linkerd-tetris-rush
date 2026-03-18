# Build context: repo root
FROM node:20-slim
WORKDIR /app
COPY api/dashboard-api/package.json ./
RUN npm install --omit=dev
COPY api/dashboard-api/index.js ./
EXPOSE 80
CMD ["node", "index.js"]
