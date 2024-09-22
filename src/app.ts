import Fastify from 'fastify'
import 'pino-pretty'

import '@logtail/pino'
const token = process.env.LOGTAIL_TOKEN;
const ts = [{
    target: 'pino-pretty',
    options: {},
    level: 'info'
}];
if (token) {
    ts.push({
        target: "@logtail/pino",
        options: { sourceToken: token },
        level: 'info'
    })
}
export const app = Fastify({
    logger: {
        transport: {
            //target: 'pino-pretty'
            //target: '@fastify/one-line-logger'
            targets: ts
        },

    }, 
    disableRequestLogging: true
});
export const log = app.log;