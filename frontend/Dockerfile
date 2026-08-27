FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS development
WORKDIR /app
ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
EXPOSE 3000
CMD ["pnpm", "dev", "--hostname", "0.0.0.0", "--port", "3000"]

FROM node:22-alpine AS builder
WORKDIR /app
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ARG NEXT_PUBLIC_PLANPILOT_WEBSITE_URL=
ARG API_URL=http://api:8000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_PLANPILOT_WEBSITE_URL=$NEXT_PUBLIC_PLANPILOT_WEBSITE_URL
ENV API_URL=$API_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:3000/ || exit 1
CMD ["node", "server.js"]
