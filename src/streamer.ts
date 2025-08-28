import { Readable } from 'node:stream';
import * as http from 'http'
import prettyBytes from 'pretty-bytes';
import { VirtualBufferCollection } from './models/VirtualBufferCollection.js';
import { getLinks, requestRefresh } from './apiClient.js';
import { sort } from 'fast-sort';
import { log } from './app.js';
import { delay } from './utils/utils.js';
import config from './config.js';
import { TypedEventEmitter } from './TypedEventEmitter.js';
import { createResumableStream, ResumableStreamCollection } from './ResumableStream.js';
import { StreamSource, StreamSourceCollection } from './models/StreamUrlModel.js';

const globalStreams: InternalStream[] = [];

const acquireStreams = async (imdbId: string, size: number) => {
    const links = await getLinks(imdbId, size);
    if (links.length === 0) throw new Error(`No valid stream found for imdbId: ${imdbId} with size: ${size}`);
    const mappedStreams = links
        .map(x => { return { streamUrl: x.playableLink, headers: x.headers, docId: x.id, speedRank: x.speedRank, status: 'HEALTHY' } as StreamSource });
    log.trace(`Found ${mappedStreams.length} healthy streams for imdbId: '${imdbId}' with size: '${size}'`)
    return mappedStreams;
}


//interface InternalStreamRequestStreamEventArgs { position: number, compensatingSlowStream?: boolean, slowStreamStreamModel?: StreamSource }
type InternalStreamRequestStreamEventArgs = {
    position: number;
} & (
        | { compensatingSlowStream: true; slowStreamStreamModel: StreamSource }
        | { compensatingSlowStream?: false; slowStreamStreamModel?: undefined }
    );
interface InternalStreamResponseStreamEventArgs { position: number, isSuccessful: boolean }

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

type LocalEventTypes = { 'response': [args: InternalStreamResponseStreamEventArgs], 'pumpresume': [arg1: InternalStreamRequestStreamEventArgs] }
class InternalStream {
    private _refreshRequested = false;
    _bufferArray = new VirtualBufferCollection();
    private _em = new TypedEventEmitter<LocalEventTypes>();
    private _resumableStreams: ResumableStreamCollection = new ResumableStreamCollection();
    _imdbId: string;
    _streamSources: StreamSourceCollection;
    _size: number;
    private _isRefreshingStreams = false;
    private _refreshTimer: NodeJS.Timer | null = null;
    async requestRefresh() {
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
            const tempstreams = await acquireStreams(this._imdbId, this._size);
            this.mergeStream(tempstreams);
        } catch (error) {
            log.error(error);
        }
        this._isRefreshingStreams = false;
        this._refreshRequested = false;
    }
    mergeStream(streams: StreamSource[]) {
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
    }


    /*
    Look for an existing stream which can satisfy the request. If not create one.
    */
    public static create = async (req: StreamerRequest) => {
        let existingStream = globalStreams.find(s => s._imdbId === req.imdbId && s._size === req.size);
        if (existingStream) {
            log.info(`Reusing existing stream for '${req.imdbId}' with size ${prettyBytes(req.size)}.`);
            await existingStream.requestRefresh();  //silent refresh of the streams
        } else {
            const tempstreams = await acquireStreams(req.imdbId, req.size);
            existingStream = new InternalStream(req.imdbId, req.size, tempstreams);
            globalStreams.push(existingStream);
        }
        return existingStream;
    }

    public get MyGotStreamCount() {
        return this._resumableStreams.length;
    }

    constructor(imdbId: string, size: number, streams: StreamSource[]) {
        this._imdbId = imdbId;
        this._size = size;
        this._streamSources = new StreamSourceCollection(streams);
    }

    private ensureBufferCoverage = async (args: InternalStreamRequestStreamEventArgs) => {
        //log.info(`stream handler event received with start position ${JSON.stringify(args.position)} and we have ${this._st?.length} streams avaialble`);        
        if (!this._resumableStreams.tryResumingStreamFromPosition(args.position)) {
            log.info(`${this._imdbId} - Constructing a new stream with args: ${JSON.stringify(args)} for size: ${prettyBytes(this._size)}`);
            const { _em, _resumableStreams: _st, _size, _bufferArray, _streamSources } = this;
            let fastestStreamSource = args.compensatingSlowStream ? _streamSources.fastestButNot(args.slowStreamStreamModel) : _streamSources.fastest();

            try {
                const newStream = await createResumableStream(fastestStreamSource, _bufferArray, _size, args.position);
                _st.addStream(newStream);
                newStream.startStreaming()
                    .finally(() => _st.removeStream(newStream));
                await newStream.waitForFirstChunk();
            } catch (error) {
                log.error((error as Error)?.message)
                _streamSources.remove(fastestStreamSource);
                requestRefresh(fastestStreamSource.docId);
            }
        }
    }

    public requestRange = (start: number, end: number, rawHttpRequest: http.IncomingMessage) => {
        log.info(`Requesting ${prettyBytes(end - start)} from ${prettyBytes(start)} for '${this._imdbId}' having size '${prettyBytes(this._size)}'`);
        const bytesRequested = end - start + 1;
        let bytesConsumed = 0,
            position = start;
        const _instance = this;
        async function* _startStreamer() {
            let lastKnownStreamInstance = null;
            while (!rawHttpRequest.destroyed) {
                if (bytesConsumed >= bytesRequested) {
                    log.info(`Guess what! we have reached the conclusion of this stream request.`);
                    break;
                }

                const __data = _instance._bufferArray.tryFetch(position, bytesRequested, bytesConsumed);                
                if (__data) {
                    /*
                    try to detect speed here and add more instances of stream downloader with advance positions
                    _instance._em.emit('pumpresume', { position + 8MB });
 
                    we can also look ahead bufferAraay to seek buffer health??
                    */

                    bytesConsumed = __data.bytesConsumed;
                    position = __data.position;

                    if (lastKnownStreamInstance && lastKnownStreamInstance.CanResolve(position)) {
                        lastKnownStreamInstance.markLastReaderPosition(position);
                    } else {
                        lastKnownStreamInstance = _instance._resumableStreams.Items.find(x => x.CanResolve(position));
                        lastKnownStreamInstance?.markLastReaderPosition(position);
                    }

                    if (lastKnownStreamInstance) {
                        if (!lastKnownStreamInstance.slowStreamHandled && lastKnownStreamInstance.isSlowStream) {
                            lastKnownStreamInstance?.markSlowStreamHandled(lastKnownStreamInstance.currentPosition + 8000000);

                            if (lastKnownStreamInstance.currentPosition + 8000000 > _instance._size) {
                                log.warn(`Slow stream detected, but the current stream cannot be bisected as the remaining length is not enough long to hold another 8MB.`);
                            } else {
                                log.warn(`Slow stream detected, adding another stream to compensate slow stream.`);
                                _instance.ensureBufferCoverage({
                                    position: lastKnownStreamInstance.currentPosition + 8000000,
                                    compensatingSlowStream: true, slowStreamStreamModel: lastKnownStreamInstance._streamUrlModel
                                });
                            }
                        }
                    }

                    yield __data.data;
                } else {
                    _instance.throwIfNoStreamUrlPresent();
                    await _instance.ensureBufferCoverage({ position });
                    //await delay(300);   //wait for 300ms    --kind of hackyy
                }
            }
            rawHttpRequest.destroyed ?
                log.info('Ooops! Seems like the underlying http request has been destroyed. Aborting now!!!') :
                log.info(`Stream transmitted ${prettyBytes(bytesConsumed)} for '${_instance._imdbId}' having size '${prettyBytes(_instance._size)}'`);

        }

        return Readable.from(_startStreamer());
    }

    public get stats() {
        return this._resumableStreams.Items.map(x => x.stats);
    }

    private throwIfNoStreamUrlPresent = () => {
        if (this._streamSources.isEmpty()) throw new Error(`There are no streamable url available to stream`);
    }

}

interface StreamerRequest {
    imdbId: string, size: number, start: number, end: number, rawHttpMessage: http.IncomingMessage
}

export const streamer = async (req: StreamerRequest) => {
    const existingStream = await InternalStream.create(req);
    return existingStream.requestRange(req.start, req.end, req.rawHttpMessage);
}


export const clearBuffers = () => {
    const stime = performance.now();
    const maxSizeBuffer = config.maxBufferSizeMB * 1000 * 1000;    //200MB buffer
    const bufferRanges = globalStreams.flatMap(x => {
        return x._bufferArray.bufferRangeIds.map(ii => {
            return {
                bufferId: ii.bufferId,
                bytesLength: ii.bytesLength,
                lastUsed: ii.lastUsed,
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

export const currentStats = () => {
    const _stmaps = globalStreams.map(x => {
        return {
            imdbId: x._imdbId,
            size: x._size,
            sizeHuman: prettyBytes(x._size),
            bufferRange: x._bufferArray.bufferRange,
            numberOfStreams: x.MyGotStreamCount,
            bufferArrayLength: x._bufferArray.bufferArrayCount,
            bufferArraySize: prettyBytes(x._bufferArray.bufferSize),
            streamStats: x.stats
        };
    });
    return _stmaps;
}
