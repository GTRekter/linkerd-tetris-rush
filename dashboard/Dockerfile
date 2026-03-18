# Build context: repo root
FROM node:20 AS builder
WORKDIR /app
COPY dashboard/client/package.json dashboard/client/yarn.lock ./
RUN yarn install --frozen-lockfile
COPY dashboard/client/ .
RUN yarn build

FROM node:20-slim
WORKDIR /app
COPY dashboard/server/package.json ./
RUN npm install --omit=dev
COPY dashboard/server/ .
COPY --from=builder /app/build ./build
EXPOSE 80
CMD ["node", "index.js"]
