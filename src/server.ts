import 'dotenv/config';
import config from './config.ts';
import fastifyStatic from '@fastify/static';
import { app } from './app.ts';
import { globalStreamRegistry } from './MediaStreamRegistry.ts';
import { parseRangeRequest } from './utils/utils.ts';
import prettyBytes from 'pretty-bytes';
import { getLinks, getPlaylistItems } from './apiClient.ts';

app.addContentTypeParser('*', { parseAs: 'buffer' }, function (request, payload, done) { done(null); });

const rootDir = `${import.meta.dirname}/..`;

const isTestMode = process.env.NODE_ENV === 'test';

function generateRandomStats() {
    return Array.from({ length: Math.floor(Math.random() * 5) + 1 }, () => {
        const size = Math.floor(Math.random() * 10000000000);
        const numStreams = Math.floor(Math.random() * 5);
        const numRequests = Math.floor(Math.random() * 5);

        return {
            imdbId: `tt${String(Math.floor(Math.random() * 9999999)).padStart(7, '0')}`,
            size,
            sizeHuman: `${(size / 1e9).toFixed(1)} GB`,
            bufferRange: Array.from({ length: Math.floor(Math.random() * 10) }, () => ({
                start: Math.floor(Math.random() * size),
                end: Math.floor(Math.random() * size),
            })),
            numberOfStreams: numStreams,
            bufferArrayLength: Math.floor(Math.random() * 1000),
            bufferArraySize: Math.floor(Math.random() * 500000000),
            streamStats: Array.from({ length: numStreams }, (_, i) => ({
                streamId: `stream-${i}`,
                sourceHost: `host-${Math.floor(Math.random() * 10)}.example.com`,
                startPosition: Math.floor(Math.random() * 1000000),
                startPositionHuman: `${(Math.random() * 100).toFixed(1)} MB`,
                currentPosition: Math.floor(Math.random() * 5000000),
                currentPositionHuman: `${(Math.random() * 500).toFixed(1)} MB`,
                lastReaderPosition: Math.floor(Math.random() * 5000000),
                lastReaderPositionHuman: `${(Math.random() * 500).toFixed(1)} MB`,
                lastUsed: new Date(Date.now() - Math.random() * 60000).toISOString(),
                lastUsedAgo: `${Math.floor(Math.random() * 60)}s ago`,
                hasHealthyBuffer: Math.random() > 0.3,
                drainRequested: Math.random() > 0.8,
                readAheadExceeded: Math.random() > 0.8,
                speedStats: {
                    currentSpeedHuman: `${(Math.random() * 10).toFixed(1)} MB/s`,
                    cumulativeSpeedHuman: `${(Math.random() * 8).toFixed(1)} MB/s`,
                },
                lastReadAheadExceededTime: Math.random() > 0.7
                    ? new Date(Date.now() - Math.random() * 300000).toISOString()
                    : null,
            })),
            streamSources: [],
            activeRequests: Array.from({ length: numRequests }, (_, i) => ({
                requestId: `req-${i}`,
                created: new Date(Date.now() - Math.random() * 30000).toISOString(),
                lastUsed: new Date(Date.now() - Math.random() * 10000).toISOString(),
                bytesConsumed: Math.floor(Math.random() * 50000000),
            })),
            created: new Date(Date.now() - Math.random() * 86400000).toISOString(),
            lastUsed: new Date().toISOString(),
        };
    });
}

app.register((route, opts, next) => {
    route.register(fastifyStatic, {
        root: `${rootDir}/public`
    });

    route.get('/', async (request, reply) => {
        return reply.sendFile('stats.htm', `${rootDir}/views`);
    });

    route.get('/cleanup', async (request, reply) => {
        globalStreamRegistry.clearBuffers();
        reply.type('application/json').code(200)
        return { success: 'ok' };
    })

    route.post<DrainStreamRequest>('/streams/:streamid/drain', (request, reply) => {
        const { streamid } = request.params;
        globalStreamRegistry.drainStream(streamid);
        reply.code(200);
        return { status: 'ok' };
    });

    route.get('/stats', async (request, reply) => {
        reply.type('application/json').code(200);
        return globalStreamRegistry.stats;
    })

    route.get('/stats/stream', { sse: true }, async (request, reply) => {
        //request.log.info('Keep connection alive (prevents automatic close)');
        reply.sse.keepAlive()

        async function sendStats() {
            const stats = isTestMode ? generateRandomStats() : globalStreamRegistry.stats;

            //request.log.info(`Sending stats to client: ${stats.length} items`);

            await reply.sse.send({
                id: Date.now().toString(),
                data: stats
            });
        }

        const interval = setInterval(async () => {
            await sendStats();
        }, 500);

        await sendStats();

        reply.sse.onClose(() => {
            clearInterval(interval)
            console.log('Connection closed')
        })
    })

    route.get('/items/movies', async (request, reply) => {
        const movies = await getPlaylistItems('plexmovie');
        reply.type('application/json').code(200);
        return movies.map(k => ({ ...k, type: 'movie' }));
    });

    route.get('/items/tv', async (request, reply) => {
        const tvShows = await getPlaylistItems('plextv');
        reply.type('application/json').code(200);
        return tvShows.map(k => ({ ...k, type: 'tv' }));
    });

    route.get<GetLinksRequest>('/links/:imdbid', async (request, reply) => {
        const { imdbid } = request.params;
        const links = await getLinks(imdbid);
        reply.type('application/json').code(200);
        return links;
    });


    //the size param is expected to start with z and followed by string which is base 32 encoded of the actual file size. This is just to make the file name compact :).
    route.head<GetStreamRequest>('/stream/:imdbid/:size', async (request, reply) => {
        const { size } = request.params;
        const documentSize = parseInt(size.substring(1), 32);
        const range = parseRangeRequest(documentSize, request.headers['range'])
            || { start: 0, end: documentSize - 1 };

        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Accept-Ranges', 'bytes');
        if (request.headers['range'] && range) {
            reply.header('Content-Range', `bytes ${range.start}-${range.end}/${documentSize}`);
            reply.header('Content-Length', range.end - range.start + 1);
            reply.code(206);
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

        request.log.info(`/stream/${imdbid}/${size} Range ${prettyBytes(range.end - range.start)} from ${prettyBytes(range.start)}`);
        if (range) {
            const resp = await globalStreamRegistry.serve({
                imdbId: imdbid.toLowerCase(),
                size: documentSize,
                start: range.start,
                end: range.end,
                rawHttpMessage: request.raw //may be see we can pass a abort signal instead of the entire http request
            });
            reply.header('Content-Type', 'application/octet-stream');
            reply.header('Accept-Ranges', 'bytes');
            reply.header('Content-Length', range.end - range.start + 1);
            reply.header('Content-Range', `bytes ${range.start}-${range.end}/${documentSize}`);
            reply.code(206);
            return reply.send(resp);
        }
        throw new Error('Only range request supported!');
    })
    next();
}, {
    prefix: config.rootPath
});


const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
for (const signal of signals) {
    process.on(signal, async () => {
        app.log.info(`Received ${signal}, shutting down gracefully...`);
        const forceExit = setTimeout(() => process.exit(1), 5000);
        forceExit.unref();
        await app.close();
        process.exit(0);
    });
}

app.listen({ port: config.DEFAULT_SERVER_PORT, host: '0.0.0.0' }, (err) => {
    app.log.info(`App build time: ${process.env.BUILD_TIME}`);
    app.log.info(`Git commit SHA: ${process.env.GIT_SHA}`);

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

interface GetLinksRequest {
    Params: {
        imdbid: string
    }
}


interface DrainStreamRequest {
    Params: {
        streamid: string
    }
}