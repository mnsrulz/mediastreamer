import 'dotenv/config';
import config from './config.js';
import fastifyStatic from '@fastify/static';
import { app } from './app.js';
import { streamer, currentStats, clearBuffers } from './streamer.js';
import { parseRangeRequest } from './utils/utils.js';
import path from 'path';

app.addContentTypeParser('*', { parseAs: 'buffer' }, function (request, payload, done) { done(null); });

const __dirname = path.resolve();

setInterval(clearBuffers, config.AUTO_CLEAR_BUFFERS_INTERVAL);   //register an auto cleanup

app.register((route, opts, next) => {
    route.register(fastifyStatic, {
        root: path.join(__dirname, 'public'),
        prefix: '/public/'
    });

    route.get('/', async (request, reply) => {
        if(!request.routerPath.endsWith('/')) return reply.redirect(`${request.routerPath}/`);
        return reply.sendFile('stats.htm', path.join(__dirname, '/views/'));
    });
    
    route.get('/cleanup', async (request, reply) => {
        clearBuffers();
        reply.type('application/json').code(200)
        return { success: 'ok' };
    })


    route.get('/stats', async (request, reply) => {
        reply.type('application/json').code(200);
        return currentStats();
    })


    //the size param is expected to start with z and followed by string which is base 32 encoded of the actual file size. This is just to make the file name compact :).
    route.head<GetStreamRequest>('/stream/:imdbid/:size', async (request, reply) => {
        const { imdbid, size } = request.params;
        const documentSize = parseInt(size.substring(1), 32);
        const range = parseRangeRequest(documentSize, request.headers['range'])
            || { start: 0, end: documentSize - 1 };

        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Accept-Ranges', 'bytes');
        if (request.headers['range'] && range) {
            reply.header('Content-Range', `bytes ${range.start}-${range.end}/${documentSize}`);
            reply.header('Content-Length', range.end - range.start + 1);
        } else {
            reply.header('Content-Length', documentSize);
        }
    });

    route.get<GetStreamRequest>('/stream/:imdbid/:size', async (request, reply) => {
        const { imdbid, size } = request.params;
        if (!size.startsWith('z')) throw new Error('Only request with size starts with z supported!');

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
    next();
}, {
    prefix: config.rootPath
});


app.listen({ port: config.DEFAULT_SERVER_PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        app.log.fatal(err.message);
        throw err
    }
})

interface GetStreamRequest {
    Params: {
        imdbid: string, size: string
    }
}
