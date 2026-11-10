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
# package.json goes in FIRST: running `npm install` without it makes npm treat /app as an empty project and delete
# every other package in node_modules. The Prisma CLI is a dev dependency that is only needed to apply migrations.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
RUN npm install --no-save --omit=dev --no-audit --no-fund prisma@6.19.3
COPY --from=build /app/prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-seed ./dist-seed
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD wget -qO- http://127.0.0.1:4000/api/health >/dev/null 2>&1 || exit 1
CMD ["node", "dist/main"]
