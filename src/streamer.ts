import { Readable } from 'node:stream';
import * as http from 'http'
import prettyBytes from 'pretty-bytes';
import { ManualResetEvent } from './utils/ManualResetEvent.js';
import { VirtualBufferCollection } from './models/VirtualBufferCollection.js';
import { getLinks, requestRefresh } from './apiClient.js';
import { sort } from 'fast-sort';
import { log } from './app.js';
import { delay } from './utils/utils.js';
import config from './config.js';
import { TypedEventEmitter } from './TypedEventEmitter.js';
import { StreamSpeedTester } from './utils/streamSpeedTester.js';
import { streamerv2, ResumableStream } from './ResumableStream.js';
import { StreamUrlModel } from './models/StreamUrlModel.js';

const globalStreams: InternalStream[] = [];

const acquireStreams = async (imdbId: string, size: number) => {
    const links = await getLinks(imdbId, size);
    if (links.length === 0) throw new Error(`no valid stream found for imdbId: ${imdbId} with size: ${size}`);
    const mappedStreams = links
        .map(x => { return { streamUrl: x.playableLink, headers: x.headers, docId: x.id, speedRank: x.speedRank, status: 'HEALTHY' } as StreamUrlModel });
    log.info(`acquire ${mappedStreams.length} streams for imdbId: '${imdbId}' with size: '${size}'`)
    return mappedStreams;
}


interface InternalStreamRequestStreamEventArgs { position: number }
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
    private _st: ResumableStream[] = [];
    _imdbId: string;
    _streamArray: StreamUrlModel[];
    _size: number;
    private _isRefreshingStreams = false;
    private _refreshTimer: NodeJS.Timer | null = null;
    async requestRefresh() {
        if (this._streamArray.length === 0) {
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
            log.info(`refreshing imdb '${this._imdbId}' streams having size '${this._size}'`);
            this._isRefreshingStreams = true;
            const tempstreams = await acquireStreams(this._imdbId, this._size);
            this.mergeStream(tempstreams);
        } catch (error) {
            log.error(error);
        }
        this._isRefreshingStreams = false;
        this._refreshRequested = false;
    }
    mergeStream(streams: StreamUrlModel[]) {
        const docIds = streams.map(x => x.docId);
        const docIdSpeedRankMap = new Map(streams.map(x => { return [x.docId, x.speedRank] }));//streams.map(x => x.docId);

        this._streamArray = [...streams, ...this._streamArray.filter(x => !docIds.includes(x.docId))];

        const fastestStream = sort(this._streamArray).desc(x => x.speedRank)[0];

        this._st.forEach(x => {
            x._streamUrlModel.speedRank = docIdSpeedRankMap.get(x._streamUrlModel.docId) || x._streamUrlModel.speedRank;
        })

        for (const currentgotstream of this._st) {
            if (currentgotstream._streamUrlModel.speedRank < fastestStream.speedRank) {
                log.info(`found a new stream '${new URL(fastestStream.streamUrl).hostname}' with rank ${fastestStream.speedRank} better than the existing '${new URL(currentgotstream._streamUrlModel.streamUrl).hostname}' ${currentgotstream._streamUrlModel.speedRank}.. draining the existing one.`);
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
            log.info(`stream request already satisfied for ${req.imdbId} with size ${req.size}. So reusing it.`);
            await existingStream.requestRefresh();  //silent refresh of the streams
        } else {
            const tempstreams = await acquireStreams(req.imdbId, req.size);
            existingStream = new InternalStream(req.imdbId, req.size, tempstreams);
            globalStreams.push(existingStream);
        }
        return existingStream;
    }

    public get MyGotStreamCount() {
        return this._st.length;
    }

    constructor(imdbId: string, size: number, streams: StreamUrlModel[]) {
        this._imdbId = imdbId;
        this._size = size;
        this._streamArray = streams;
    }

    private removeGotStreamInstance = (streamInstance: ResumableStream) => {
        log.info(`removing the gostream with stats: ${JSON.stringify(streamInstance.stats)}`)
        this._st = this._st.filter(item => item != streamInstance);
    }

    private _pendingStreams = new Set<number>();
    private streamHandler = async (args: InternalStreamRequestStreamEventArgs) => {
        //log.info(`stream handler event received with start position ${JSON.stringify(args.position)} and we have ${this._st?.length} streams avaialble`);
        const exisitngStreams = this._st.filter(x => x.CanResolve(args.position));
        if (exisitngStreams) {
            //log.info(`existing stream found which can satisfy it. args: ${JSON.stringify(args)}`);
            exisitngStreams.forEach(x => x.resume());
        }
        // else if (this._pendingStreams.has(args.position)) {   //if the streamer is in pending state await for few seconds.
        //     log.warn(`${this._imdbId} - There is already a stream request awaiting for position: ${args.position} for size: ${this._size}. Waiting for a few seconds to let it resolve.`);
        //     await delay(3000);
        // }
        else {
            log.info(`${this._imdbId} - constructing a new stream with args: ${JSON.stringify(args)} for size: ${this._size}`);
            this._pendingStreams.add(args.position);
            const { _em, _st, _size, _bufferArray, _streamArray, removeGotStreamInstance } = this;
            const firstStreamUrlModel = sort(_streamArray).desc(x => x.speedRank)[0];

            try {
                const newStream = await streamerv2(firstStreamUrlModel, _bufferArray, _size, args.position);
                _st.push(newStream);
                newStream.startStreaming()
                    .finally(() => removeGotStreamInstance(newStream));
            } catch (error) {
                log.error((error as Error)?.message)
                this._streamArray = this._streamArray.filter(x => x != firstStreamUrlModel);
                requestRefresh(firstStreamUrlModel.docId);
            } finally {
                this._pendingStreams.delete(args.position);
            }
        }
    }

    public pumpV2 = (start: number, end: number, rawHttpRequest: http.IncomingMessage) => {
        log.info(`pumpv2 called with ${start}-${end} range`);
        const bytesRequested = end - start + 1;
        let bytesConsumed = 0,
            position = start;
        const _instance = this;
        async function* _startStreamer() {
            const stimer = new StreamSpeedTester();
            try {
                while (!rawHttpRequest.destroyed) {
                    if (bytesConsumed >= bytesRequested) {
                        log.info(`Guess what! we have reached the conclusion of this stream request.`);
                        break;
                    }

                    const __data = _instance._bufferArray.tryFetch(position, bytesRequested, bytesConsumed);
                    //we should advance the resume if we knew we are about to reach the buffer end
                    if (__data) {
                        /*
                        try to detect speed here and add more instances of stream downloader with advance positions
                        _instance._em.emit('pumpresume', { position + 8MB });
    
                        we can also look ahead bufferAraay to seek buffer health??
                        */
                        stimer.addData(__data.data.byteLength);

                        bytesConsumed = __data.bytesConsumed;
                        position = __data.position;
                        const exisitngStream = _instance._st.find(x => x.CanResolve(position));
                        exisitngStream?.markLastReaderPosition(position);
                        yield __data.data;
                    } else {
                        _instance.throwIfNoStreamUrlPresent();
                        await _instance.streamHandler({ position });
                    }
                    await delay(300);   //wait for 300ms    --kind of hackyy
                }
                rawHttpRequest.destroyed ?
                    log.info('request was destroyed') :
                    log.info(`Stream pumpV2 finished with bytesConsumed=${bytesConsumed} and bytesRequested=${bytesRequested}`);
            } finally {
                stimer.Clear();
            }
        }

        return Readable.from(_startStreamer());
    }

    public get stats() {
        return this._st.map(x => x.stats);
    }

    private throwIfNoStreamUrlPresent = () => {
        if (this._streamArray.length == 0) throw new Error(`there are no streamable url available to stream`);
    }

}

interface StreamerRequest {
    imdbId: string, size: number, start: number, end: number, rawHttpMessage: http.IncomingMessage
}

export const streamer = async (req: StreamerRequest) => {
    const existingStream = await InternalStream.create(req);
    return existingStream.pumpV2(req.start, req.end, req.rawHttpMessage);
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
        log.info(`cleanup ${cleanupItems} items to ${prettyBytes(cleanupSize)} in ${ftime - stime} ms`);
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
