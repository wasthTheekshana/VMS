# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npx nest build \
 && npx tsc prisma/seed.ts --outDir dist-seed --module commonjs --target es2022 --esModuleInterop --skipLibCheck \
 && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# The Prisma CLI is only needed to apply migrations at deploy time.
COPY --from=build /app/node_modules ./node_modules
RUN npm install --no-save --no-audit --no-fund prisma@6.19.3
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-seed ./dist-seed
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD wget -qO- http://127.0.0.1:4000/api/auth/me >/dev/null 2>&1 || [ $? -eq 8 ]
CMD ["node", "dist/main"]
