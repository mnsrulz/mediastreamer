FROM node:20 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

RUN npm run build

FROM node:20-alpine
WORKDIR /app

COPY ./views ./views
COPY ./public ./public
COPY ./frontrailpresets ./frontrailpresets
COPY package*.json ./

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "."]