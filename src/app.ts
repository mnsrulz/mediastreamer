import { streamer, currentStats, clearBuffers } from './streamer.js';
import Fastify from 'fastify'
import { parseRangeRequest } from './utils.js';

const fastify = Fastify({ logger: false });

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


    // reply.type('application/json').code(200)
    // return links;

    /*
    1. GET ALL THE ACTIVE LINKS ASSOCIATED WITH THIS IMDB AND SIZE COMBINATION 
    2. GRAB THE TOP MOST LINK AND START THE STREAMER PROCESS
    
    THERE SHOULD BE A WAY TO CALL THE API TO GET THE LINKS AND
        TO MARK A SPECIFIC DOCUMENTID TO REFRESH
    */


    const range = parseRangeRequest(documentSize, request.headers['range'])
        || { start: 0, end: documentSize - 1 };

    console.log(`request recvd... ${JSON.stringify(range)}`);
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
        console.log(err.message);
        throw err
    }
    console.log(`Server is now listening on ${address}`);
})