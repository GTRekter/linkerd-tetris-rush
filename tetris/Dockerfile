# Build context: repo root
FROM node:20 AS builder
WORKDIR /app
COPY tetris/client/package.json ./
RUN yarn install
COPY tetris/client/ .
RUN yarn build

FROM node:20-slim
WORKDIR /app
COPY tetris/server/package.json ./
RUN npm install --omit=dev
COPY tetris/server/ .
COPY --from=builder /app/build ./build
EXPOSE 80
CMD ["node", "index.js"]
