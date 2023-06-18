import Fastify from 'fastify'
export const fastify = Fastify({ logger: {
    transport: {
        //target: 'pino-pretty'
        target: '@fastify/one-line-logger'
    }
} });
export const log = fastify.log;