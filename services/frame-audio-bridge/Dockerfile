FROM node:22-alpine AS build

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=optional
RUN npm install --no-save --package-lock=false @snazzah/davey-linux-x64-musl@0.1.11

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=dev --omit=optional
RUN npm install --no-save --package-lock=false @snazzah/davey-linux-x64-musl@0.1.11

COPY --from=build /app/dist ./dist
COPY public ./public

EXPOSE 3728
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3728/healthz >/dev/null || exit 1
CMD ["node", "dist/index.js"]
