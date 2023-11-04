FROM node:20 AS builder
# RUN apk add --update npm
WORKDIR /app
COPY package*.json ./
RUN npm ci
# RUN npm i -g @vercel/ncc
COPY . .
# RUN ncc build src/server.ts --minify -o dist --target es2021

RUN npm run build

FROM node:20-alpine
# RUN apk add --update nodejs
WORKDIR /app

COPY ./views ./views
COPY ./public ./public
COPY ./frontrailpresets ./frontrailpresets
COPY package*.json ./

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "."]