FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY app.js ./
COPY lib ./lib

EXPOSE 3000

CMD ["node", "app.js"]
