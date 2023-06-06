import got from 'got';
import { streamer, sampleStreamUrl, parseRangeRequest } from './streamer.js';
import Fastify from 'fastify'

const fastify = Fastify({ logger: false });

fastify.addContentTypeParser('*', { parseAs: 'buffer' }, function (request, payload, done) { done(null); });

fastify.get('/', async (request, reply) => {
    reply.type('application/json').code(200)
    return { hello: 'world' }
})

fastify.get('/stream.mkv', async (request, reply) => {
    let parsedRangeRequest = parseRangeRequest(request.headers['range']);
    console.log(`parsedRangeRequest: ${JSON.stringify(parsedRangeRequest)}`);

    const head = await got.head(sampleStreamUrl, { https: { rejectUnauthorized: false } });
    if (head.statusCode >= 400) throw new Error(`${head.statusCode} code received.`);
    const clHeader = Number.parseInt(head.headers['content-length'] || '0');
    console.log(`clHeader: ${clHeader}`);

    if (!parsedRangeRequest) {
        parsedRangeRequest = { rangeStart: 0, rangeEnd: clHeader - 1 };
    }

    if (parsedRangeRequest) {
        if (Number.isNaN(parsedRangeRequest.rangeEnd))
            parsedRangeRequest.rangeEnd = clHeader - 1;

        const resp = await streamer({
            streamUrl: sampleStreamUrl,
            start: parsedRangeRequest.rangeStart,
            end: parsedRangeRequest.rangeEnd,
            message: request.raw
        });
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Accept-Ranges', 'bytes');
        reply.header('Content-Length', parsedRangeRequest.rangeEnd - parsedRangeRequest.rangeStart + 1);
        reply.header('Content-Range', `bytes ${parsedRangeRequest.rangeStart}-${parsedRangeRequest.rangeEnd}/${clHeader}`);
        return reply.send(resp);
    }
    throw new Error('Only range request supported!');
})

fastify.listen({ port: 3000 }, (err, address) => {
    if (err) {
        console.log(err.message);
        throw err
    }
    console.log(`Server is now listening on ${address}`);
})