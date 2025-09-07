import { Readable } from 'node:stream';
import * as http from 'http'
import prettyBytes from 'pretty-bytes';
import { VirtualBufferCollection } from './models/VirtualBufferCollection.js';
import { getLinks, requestRefresh } from './apiClient.js';
import { sort } from 'fast-sort';
import { log } from './app.js';
import { delay } from './utils/utils.js';
import config from './config.js';
import { createResumableStream, ResumableStreamCollection } from './ResumableStream.js';
import { StreamSource, StreamSourceCollection } from './models/StreamUrlModel.js';
import dayjs from 'dayjs';

const acquireStreams = async (imdbId: string, size: number) => {
    const links = await getLinks(imdbId, size);
    if (links.length === 0) throw new Error(`No valid stream found for imdbId: ${imdbId} with size: ${size}`);
    const mappedStreams = links
        .map(x => { return { streamUrl: x.playableLink, headers: x.headers, docId: x.id, speedRank: x.speedRank, status: 'HEALTHY' } as StreamSource });
    log.trace(`Found ${mappedStreams.length} healthy streams for imdbId: '${imdbId}' with size: '${size}'`)
    return mappedStreams;
}


//interface InternalStreamRequestStreamEventArgs { position: number, compensatingSlowStream?: boolean, slowStreamStreamModel?: StreamSource }
type ResumableMediaStreamRequestStreamEventArgs = {
    position: number;
} & (
        | { compensatingSlowStream: true; slowStreamStreamModel: StreamSource }
        | { compensatingSlowStream?: false; slowStreamStreamModel?: undefined }
    );
/*
TODO:
1: Allow multiple urls to processed simultaneously
2: Cleanup the array buffer based on some priority. Like start/end range of files should remain there for long time and use lastUsed property
3: Set a static list of hostnames and their pre configured values like
    how many concurrent streams allowed and their ttl (e.g. google streams are good so we can keep the for longer)
    define the order which the stream dispose
    support stream which allows single connection only like clicknupload
4: speed detection would be wonderful to add.
*/

class ResumableMediaStream {
    private _refreshRequested = false;
    readonly _bufferArray = new VirtualBufferCollection();
    private readonly _resumableStreams = new ResumableStreamCollection();
    _imdbId: string;
    _streamSources: StreamSourceCollection;
    _size: number;
    private _isRefreshingStreams = false;
    private _refreshTimer: NodeJS.Timeout | null = null;
    private _internalPromise: Promise<void>;
    private _created = new Date();
    private _lastUsed = new Date();

    /**these represnets the active clients which are currently consuming the streams*/
    readonly _activeRequests: ActiveRequestCollection = new ActiveRequestCollection();
    requestRefresh = async () => {
        if (this._streamSources.isEmpty()) {
            if (!this._isRefreshingStreams) {
                this.performRefresh();
                await delay(3000);  //let's wait for 3seconds when the stream array is empty as it might be refreshing...
            }
            return;
        }
        if (this._refreshRequested) return;
        this._refreshRequested = true;
        this._refreshTimer = setTimeout(this.performRefresh, config.refreshInterval);   //after 30 seconds perform refresh of links
    }
    performRefresh = async () => {
        try {
            log.trace(`Refreshing streams for imdb '${this._imdbId}' having size '${prettyBytes(this._size)}'`);
            this._isRefreshingStreams = true;
            const streams = await acquireStreams(this._imdbId, this._size);
            const docIdSpeedRankMap = new Map(streams.map(x => { return [x.docId, x.speedRank] }));//streams.map(x => x.docId);
            this._streamSources.merge(streams);
            const fastestStream = this._streamSources.fastest();
            this._resumableStreams.updateSpeedRanks(docIdSpeedRankMap);

            for (const currentgotstream of this._resumableStreams.Items) {
                if (currentgotstream._streamUrlModel.speedRank < fastestStream.speedRank) {
                    log.info(`Found a new stream '${new URL(fastestStream.streamUrl).hostname}' with rank ${fastestStream.speedRank} better than the existing '${new URL(currentgotstream._streamUrlModel.streamUrl).hostname}' ${currentgotstream._streamUrlModel.speedRank}.. draining the existing one.`);
                    currentgotstream.drainIt(); //drain this stream and let other one consume
                }
            }
        } catch (error) {
            log.error(error);
        }
        this._isRefreshingStreams = false;
        this._refreshRequested = false;
    }

    public get StreamsCount() {
        return this._resumableStreams.length;
    }

    public get Created() {
        return this._created;
    }
    public get LastUsed() {
        return this._lastUsed;
    }

    constructor(imdbId: string, size: number) {
        this._imdbId = imdbId;
        this._size = size;
        this._streamSources = new StreamSourceCollection([]);
        this._internalPromise = acquireStreams(imdbId, size).then(k => {
            this._streamSources = new StreamSourceCollection(k)
        })
    }

    private ensureBufferCoverage = async (args: ResumableMediaStreamRequestStreamEventArgs) => {
        if (!this._resumableStreams.tryResumingStreamFromPosition(args.position)) {
            const { _resumableStreams, _size, _bufferArray, _streamSources } = this;
            let fastestStreamSource = _streamSources.fastest();
            if (args.compensatingSlowStream) {
                fastestStreamSource = _streamSources.fastestButNot(args.slowStreamStreamModel) || fastestStreamSource;
            }

            if (!fastestStreamSource) {
                log.error(`No stream source available to create a new stream for '${this._imdbId}'`);
                return;
            }

            try {
                const newStream = await createResumableStream(fastestStreamSource, _bufferArray, _size, args.position);
                _resumableStreams.addStream(newStream);
                newStream.startStreaming()
                    .finally(() => _resumableStreams.removeStream(newStream));
            } catch (error) {
                log.error((error as Error)?.message)
                _streamSources.remove(fastestStreamSource);
                requestRefresh(fastestStreamSource.docId);
            }
        }
    }

    public drainStream(streamId: string) {
        const stream = this._resumableStreams.Items.find(x => x.streamId === streamId);
        if (stream) {
            stream.drainIt();
            return true;
        } 
        return false;
    }

    public requestRange = async (start: number, end: number, rawHttpRequest: http.IncomingMessage) => {
        await this._internalPromise;    //this should first time wait only.
        log.info(`Requesting ${prettyBytes(end - start)} from ${start === 0 ? 'beginning' : prettyBytes(start)} for '${this._imdbId}' having size '${prettyBytes(this._size)}'`);
        const bytesRequested = end - start + 1;
        let bytesConsumed = 0,
            position = start;
        const { _activeRequests, _bufferArray, _resumableStreams, _imdbId, _size, ensureBufferCoverage, throwIfNoStreamUrlPresent, markLastUsedAsNow } = this;
        async function* _startStreamer() {
            let lastKnownStreamInstance = null;
            const incomingRequest = { start: start, end: end, requestId: crypto.randomUUID(), bytesConsumed: 0, created: new Date() } as ActiveRequest;
            _activeRequests.add(incomingRequest);
            try {
                while (!rawHttpRequest.destroyed) {
                    if (bytesConsumed >= bytesRequested) {
                        log.info(`Guess what! we have reached the conclusion of this stream request.`);
                        break;
                    }

                    const __data = _bufferArray.tryFetch(position, bytesRequested, bytesConsumed);
                    if (__data) {
                        /*
                        try to detect speed here and add more instances of stream downloader with advance positions
                        _instance._em.emit('pumpresume', { position + 8MB });
     
                        we can also look ahead bufferAraay to seek buffer health??
                        */

                        bytesConsumed = __data.bytesConsumed;
                        position = __data.position;

                        incomingRequest.bytesConsumed = bytesConsumed;
                        incomingRequest.lastUsed = new Date();

                        if (lastKnownStreamInstance && lastKnownStreamInstance.CanResolve(position)) {
                            lastKnownStreamInstance.markLastReaderPosition(position);
                        } else {
                            lastKnownStreamInstance = _resumableStreams.Items.find(x => x.CanResolve(position));
                            lastKnownStreamInstance?.markLastReaderPosition(position);
                        }

                        if (lastKnownStreamInstance) {  //need to revisit the slow stream detection logic
                            if (!lastKnownStreamInstance.slowStreamHandled && lastKnownStreamInstance.isSlowStream) {
                                lastKnownStreamInstance?.markSlowStreamHandled(lastKnownStreamInstance.currentPosition + 8000000);

                                if (lastKnownStreamInstance.currentPosition + 8000000 > _size) {
                                    log.warn(`Slow stream detected, but the current stream cannot be bisected as the remaining length is not enough long to hold another 8MB.`);
                                } else {
                                    log.warn(`Slow stream detected, adding another stream to compensate slow stream.`);
                                    ensureBufferCoverage({
                                        position: lastKnownStreamInstance.currentPosition + 8000000,
                                        compensatingSlowStream: true, slowStreamStreamModel: lastKnownStreamInstance._streamUrlModel
                                    });
                                }
                            }
                        }

                        yield __data.data;
                    } else {
                        throwIfNoStreamUrlPresent();
                        await ensureBufferCoverage({ position });
                        await _bufferArray.waitForNewData(30000);
                    }
                    markLastUsedAsNow();
                }
            } catch (error) {
                log.error(`Error occurred in the streamer. Error: ${error}`);
            } finally {
                if (rawHttpRequest.destroyed)
                    log.warn(`Ooops! Seems like the underlying http request has been destroyed. Aborting now!!! Transmitted: ${prettyBytes(bytesConsumed)}`)
                else
                    log.info(`Stream transmitted ${prettyBytes(bytesConsumed)} for '${_imdbId}' having size '${prettyBytes(_size)}'`);
                _activeRequests.remove(incomingRequest);
            }
        }

        return Readable.from(_startStreamer());
    }

    private markLastUsedAsNow = () => {
        this._lastUsed = new Date();
    }
    public get stats() {
        return this._resumableStreams.Items.map(x => x.stats);
    }

    private throwIfNoStreamUrlPresent = () => {
        if (this._streamSources.isEmpty()) throw new Error(`There are no streamable url available to stream`);
    }

    public dispose = () => {
        this._resumableStreams.dispose();
    }
}

interface StreamerRequest {
    imdbId: string, size: number, start: number, end: number, rawHttpMessage: http.IncomingMessage
}


type ActiveRequest = { requestId: string, start: number, end: number, bytesConsumed: number, created: Date, lastUsed?: Date };
class ActiveRequestCollection {
    private _streams: ActiveRequest[] = [];

    public add(stream: ActiveRequest) {
        this._streams.push(stream);
    }

    public remove(stream: ActiveRequest) {
        this._streams = this._streams.filter(s => s !== stream);
    }

    public get items() {
        return this._streams.map(k => ({ ...k }));
    }
}

class MediaStreamRegistry {
    drainStream(streamid: string) {
        for(const s of this._streams) {
            if (s.drainStream(streamid)) return;
        }
        log.warn(`No stream found with streamId '${streamid}' to drain`);        
    }

    private _streams: ResumableMediaStream[] = [];

    constructor() {
        log.info(`MediaStreamRegistry initialized`);
        setInterval(this.clearBuffers, config.AUTO_CLEAR_BUFFERS_INTERVAL);   //register an auto cleanup
        log.info(`Auto cleanup buffers set to run every ${config.AUTO_CLEAR_BUFFERS_INTERVAL / 1000} seconds`);
        setInterval(this.cleanupIdleStreams, config.AUTO_CLEAR_IDLE_STREAMS_INTERVAL);
        log.info(`Auto cleanup idle streams set to run every ${config.AUTO_CLEAR_IDLE_STREAMS_INTERVAL / 1000} seconds`);
    }

    public find(imdbId: string, size: number) {
        return this._streams.find(s => s._imdbId === imdbId && s._size === size);
    }

    private addStream(stream: ResumableMediaStream) {
        this._streams.push(stream);
    }

    public serve = async (req: StreamerRequest) => {
        let mediaStream = this.find(req.imdbId, req.size);
        if (mediaStream) {
            log.info(`Reusing existing stream for '${req.imdbId}' with size ${prettyBytes(req.size)}.`);
            await mediaStream.requestRefresh();  //silent refresh of the streams
        } else {
            mediaStream = new ResumableMediaStream(req.imdbId, req.size);
            this.addStream(mediaStream);
        }
        return await mediaStream.requestRange(req.start, req.end, req.rawHttpMessage);
    }

    /**
     * stats
     */
    public get stats() {
        return this._streams.map(x => {
            return {
                imdbId: x._imdbId,
                size: x._size,
                sizeHuman: prettyBytes(x._size),
                bufferRange: x._bufferArray.bufferRange,
                numberOfStreams: x.StreamsCount,
                bufferArrayLength: x._bufferArray.bufferArrayCount,
                bufferArraySize: prettyBytes(x._bufferArray.bufferSize),
                streamStats: x.stats,
                streamSources: x._streamSources.items,
                activeRequests: x._activeRequests.items,
                created: x.Created,
                lastUsed: x.LastUsed
            };
        });
    }

    private cleanupIdleStreams = () => {
        const now = dayjs();
        const idleStreams = this._streams.filter(stream => {
            const lastUsed = dayjs(stream.LastUsed);
            return now.diff(lastUsed, 'millisecond') > config.maxIdleStreamTimeout;
        });

        if (idleStreams.length > 0) {
            log.info(`Cleaning up ${idleStreams.length} idle streams which are not used since last ${config.maxIdleStreamTimeout / 1000} seconds`);
            for (const stream of idleStreams) {
                const index = this._streams.indexOf(stream); // find element index
                if (index > -1) {
                    this._streams.splice(index, 1); // removes 1 element at that index
                }
                log.info(`Disposing media stream for '${stream._imdbId}' having size '${prettyBytes(stream._size)}' due to idle timeout`);
                stream.dispose();
            }
        } else {
            log.info(`No idle streams to clean up.`);
        }
    };

    clearBuffers = () => {
        const stime = performance.now();
        const maxSizeBuffer = config.maxBufferSizeMB * 1000 * 1000;    //200MB buffer
        const bufferRanges = this._streams.flatMap(x => {
            return x._bufferArray.bufferRangeIds.map(({ bufferId, bytesLength, lastUsed }) => {
                return {
                    bufferId,
                    bytesLength,
                    lastUsed,
                    bufferCollection: x._bufferArray
                }
            });
        });

        const bufferRangesSorted = sort(bufferRanges).desc(x => x.lastUsed);
        let runningSize = 0;
        let cleanupItems = 0, cleanupSize = 0;
        const buffersToClean: { bufferIds: string[], bufferCollection: VirtualBufferCollection }[] = [];
        bufferRangesSorted.forEach(x => {
            runningSize = runningSize + x.bytesLength;
            if (runningSize > maxSizeBuffer) {
                //buffer size reached so clean up the remaining...
                let existingItem = buffersToClean.find(c => c.bufferCollection === x.bufferCollection);
                if (!existingItem) {
                    existingItem = {
                        bufferCollection: x.bufferCollection,
                        bufferIds: []
                    }
                    buffersToClean.push(existingItem);
                }
                existingItem.bufferIds.push(x.bufferId);
                cleanupItems++;
                cleanupSize += x.bytesLength;
            }
        });

        if (cleanupItems > 0) {
            buffersToClean.forEach(x => x.bufferCollection.clearBuffers(x.bufferIds));
            const ftime = performance.now();
            log.info(`Cleanup ${cleanupItems} items to ${prettyBytes(cleanupSize)} in ${ftime - stime} ms`);
        }
    }
}


export const globalStreamRegistry = new MediaStreamRegistry();