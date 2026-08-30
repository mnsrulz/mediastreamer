FROM node:22 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
# Install production dependencies
RUN npm ci --omit=dev

COPY ./views ./views
COPY ./public ./public
COPY ./frontrailpresets ./frontrailpresets

ARG BUILD_TIME
ARG GIT_SHA

ENV BUILD_TIME=$BUILD_TIME
ENV GIT_SHA=$GIT_SHA
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "."]