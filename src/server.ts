import { fastify } from './app.js';
import { streamer, currentStats, clearBuffers } from './streamer.js';
import { parseRangeRequest } from './utils.js';

fastify.addContentTypeParser('*', { parseAs: 'buffer' }, function (request, payload, done) { done(null); });

fastify.get('/', async (request, reply) => {
    reply.type('application/json').code(200)
    return { hello: 'world123' }
})

setInterval(clearBuffers, 10 * 60 * 1000);   //register an auto cleanup

fastify.get('/cleanup', async (request, reply) => {
    clearBuffers();
    reply.type('application/json').code(200)
    return { success: 'ok' };
})


fastify.get('/stats', async (request, reply) => {
    reply.type('application/json').code(200);
    return currentStats();
})

interface GetStreamRequest {
    Params: {
        imdbid: string, size: string
    }
}

fastify.get<GetStreamRequest>('/stream/:imdbid/:size', async (request, reply) => {
    const { imdbid, size } = request.params;
    if (!size.startsWith('S')) throw new Error('Only request with size starts with S supported!');

    const documentSize = parseInt(size.substring(1), 32);
    const range = parseRangeRequest(documentSize, request.headers['range'])
        || { start: 0, end: documentSize - 1 };

    request.log.info(`stream range: ${range.start}-${range.end} requested for imdbId: ${imdbid} having size ${size}`);
    if (range) {
        const resp = await streamer({
            imdbId: imdbid.toLowerCase(),
            size: documentSize,
            start: range.start,
            end: range.end,
            rawHttpMessage: request.raw
        });
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Accept-Ranges', 'bytes');
        reply.header('Content-Length', range.end - range.start + 1);
        reply.header('Content-Range', `bytes ${range.start}-${range.end}/${documentSize}`);
        return reply.send(resp);
    }
    throw new Error('Only range request supported!');
})

fastify.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
    if (err) {
        fastify.log.fatal(err.message);
        throw err
    }
    //fastify.log.info(`Server is now listening on ${address}....`);
})