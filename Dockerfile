FROM node:24-alpine AS build

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN corepack enable && pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

FROM node:24-slim

WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/agent.aieos.json ./
COPY --from=build /app/mcp.json ./
COPY --from=build /app/skills ./skills
COPY --from=build /app/HEARTBEAT.md ./

# shell tools run in /home/skiff (SHELL_WORK_DIR), not the app CWD
RUN groupadd --system skiff && useradd --system --gid skiff --create-home skiff

USER skiff

CMD ["node", "/app/dist/index.js"]
