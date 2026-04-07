FROM oven/bun:1-alpine AS builder

WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install
COPY . .
RUN bun run build

FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --production
COPY --from=builder /app/dist ./dist
EXPOSE 3002
CMD ["bun", "run", "start"]
