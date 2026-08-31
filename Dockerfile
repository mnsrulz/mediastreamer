FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

ARG BUILD_TIME
ARG GIT_SHA

ENV BUILD_TIME=$BUILD_TIME
ENV GIT_SHA=$GIT_SHA

EXPOSE 3000

CMD ["node", "src/server.ts"]