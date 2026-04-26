# Dockerfile
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install deps
COPY package.json ./
RUN npm install --omit=dev

# App files
COPY server.js ./
COPY public ./public

# Serve on 8080
EXPOSE 8080
CMD ["npm", "start"]
