import { Readable } from 'node:stream';
import * as http from 'http'
import { EventEmitter } from 'node:events';
import got, { Request, Response } from 'got';
import prettyBytes from 'pretty-bytes';
import dayjs from 'dayjs'
import { pEvent } from 'p-event';
import { ManualResetEvent } from './ManualResetEvent.js';
import { MyBufferCollection } from './MyBufferCollection.js';
import { getLinks, requestRefresh } from './apiClient.js';
import { sort } from 'fast-sort';
import { log } from './app.js';
import { delay, parseContentLengthFromRangeHeader } from './utils.js';
import config from './config.js';
import { TypedEventEmitter } from './TypedEventEmitter.js';


const globalStreams: InternalStream[] = [];

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
    const buffersToClean: { bufferIds: string[], bufferCollection: MyBufferCollection }[] = [];
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

class MyGotStream {
    public startPosition = 0;
    public currentPosition = 0;
    private _lastReaderPosition = 0;
    public lastUsed = new Date();
    private _drainRequested = false;
    private _gotStream: Request;
    _internalstream: InternalStream;
    _mre = ManualResetEvent.createNew();
    intervalPointer: NodeJS.Timer;
    bus = new EventEmitter();
    isSuccessful = false;
    _streamUrlModel: StreamUrlModel;
    private _readAheadExceeded = false;

    constructor(internalstream: InternalStream, initialPosition: number) {
        this._internalstream = internalstream;

        this._streamUrlModel = sort(internalstream._streamArray).desc(x => x.speedRank)[0];

        log.info(`Building a new MyGotStream ${new URL(this._streamUrlModel.streamUrl).host} having rank ${this._streamUrlModel.speedRank
            } with initialPosition: ${initialPosition}`);

        const _i = this;
        _i.startPosition = initialPosition;
        _i.currentPosition = initialPosition;
        _i._lastReaderPosition = initialPosition;

        const _internalHeaders = this._streamUrlModel.headers || {};
        _internalHeaders['Range'] = `bytes=${_i.currentPosition}-`;

        this._gotStream = got.stream(this._streamUrlModel.streamUrl, {
            https: { rejectUnauthorized: false },
            headers: _internalHeaders,
            throwHttpErrors: false
        }).on('response', (response: Response) => {
            if (response.statusCode >= 200 && response.statusCode < 300) {
                const contentLengthHeader = parseInt(response.headers['content-length'] || '0');
                const potentialContentLength = parseContentLengthFromRangeHeader(response.headers['content-range'] || '')
                    || contentLengthHeader;

                if (internalstream._size !== potentialContentLength) {
                    log.info(`content length mismatch: E/A ${internalstream._size}/${potentialContentLength}`);
                } else {
                    log.info(`successful stream acquired with matching content length ${potentialContentLength}`);
                    _i.isSuccessful = true;
                }
            } else {
                log.warn(`non successfull response code received: ${response.statusCode}`);
            }
            if (!_i.isSuccessful) {
                internalstream._streamArray = internalstream._streamArray.filter(x => x != this._streamUrlModel);
                requestRefresh(this._streamUrlModel.docId);
            }
            _i._mre.set();
        }).on('error', (err) => {
            log.error(`error occurred during the gotstream: ${err.message}`);
            _i._mre.set();
            // internalstream._streamArray = internalstream._streamArray.filter(x => x != this._streamUrlModel);
            // requestRefresh(this._streamUrlModel.docId);
        });

        //this is to show if the stream break the code behaves appropriately.
        this.intervalPointer = setInterval(() => {
            if (dayjs(_i.lastUsed).isBefore(dayjs(new Date()).subtract(10, 'minute'))) {
                log.warn(`ok.. forcing the stream to auto destroy after idling for more than 10 minute`);
                _i.drainIt();
            }
        }, 20000);
    }

    public startStreaming = async () => {
        const _self = this;
        try {
            await this._mre.wait();
            if (!_self.isSuccessful) throw new Error(`non successfull stream response recvd...`);
            log.info(`yay! we found a good stream... traversing it..`);
            for await (const chunk of _self._gotStream) {
                const _buf = (chunk as Buffer);
                _self._internalstream._bufferArray.push(_buf, _self.currentPosition);
                _self.currentPosition += _buf.byteLength;
                _self.lastUsed = new Date();
                while (!_self._drainRequested && _self.currentPosition > _self._lastReaderPosition + (config.readAheadSizeMB * 1024 * 1024)) {    //advance bytes
                    _self._readAheadExceeded = true;
                    await pEvent(_self.bus, 'unlocked');
                }
                _self._readAheadExceeded = false;
            }
        } catch (error) {
            _self._drainRequested ?
                log.info(`stream ended as drain requested`) :
                log.error(`error occurred while iterating the stream...`);    //in case of errors the system will just create a new stream automatically.
        } finally {
            clearInterval(this.intervalPointer);
        }
    }

    public CanResolve = (position: number) => position >= this.startPosition && position <= this.currentPosition;

    public resume = () => {
        this.lastUsed = new Date();
        this._lastReaderPosition = this.currentPosition;
        this.bus.emit('unlocked');
    }

    //maybe a better name needed but this is helpful to advance the position of the stream if it's in read exhaust mode
    public markLastReaderPosition = (position: number) => {
        if (this._lastReaderPosition < position) {
            this._lastReaderPosition = position;
            this.bus.emit('unlocked');
        }
    }

    public drainIt = () => {
        log.info(`drain requested so destryoing the existing stream...`);
        this._drainRequested = true;
        this._gotStream.destroy();
        this.bus.emit('unlocked');
    }


    public get stats() {
        const { lastUsed, startPosition, _lastReaderPosition, _drainRequested, currentPosition, _readAheadExceeded } = this;
        return {
            startPosition,
            lastUsed,
            currentPosition,
            lastReaderPosition: _lastReaderPosition,
            drainRequested: _drainRequested,
            readAheadExceeded: _readAheadExceeded
        };
    }

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
    _bufferArray = new MyBufferCollection();
    private _em = new TypedEventEmitter<LocalEventTypes>();
    private _st: MyGotStream[] = [];
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
            const tempstreams = await InternalStream.acquireStreams(this._imdbId, this._size);
            this.mergeStream(tempstreams);
        } catch (error) {
            log.info(`error occurred while refreshing the streams for imdb: ${this._imdbId}, size: ${this._size}`);
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

    private static acquireStreams = async (imdbId: string, size: number) => {
        const links = await getLinks(imdbId, size);
        if (links.length === 0) throw new Error('no valid stream found');
        return links
            .map(x => { return { streamUrl: x.playableLink, headers: x.headers, docId: x._id, speedRank: x.speedRank, status: 'HEALTHY' } as StreamUrlModel });
    }

    /*
    Look for an existing stream which can satisfy the request. If not create one.
    */
    public static create = async (req: StreamerRequest) => {
        let existingStream = globalStreams.find(s => s._imdbId === req.imdbId && s._size === req.size);
        if (existingStream) {
            await existingStream.requestRefresh();  //silent refresh of the streams
        } else {
            const tempstreams = await InternalStream.acquireStreams(req.imdbId, req.size);
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
        this._em.on('pumpresume', this.streamHandler);
    }

    private removeGotStreamInstance = (streamInstance: MyGotStream) => {
        log.info(`removing the gostream with stats: ${JSON.stringify(streamInstance.stats)}`)
        this._st = this._st.filter(item => item != streamInstance);
    }

    private streamHandler = async (args: InternalStreamRequestStreamEventArgs) => {
        log.trace(`stream handler event received with start position ${JSON.stringify(args.position)} and we have ${this._st?.length} streams avaialble`);
        const exisitngStream = this._st.find(x => x.CanResolve(args.position));
        if (exisitngStream) {
            log.trace(`existing stream found which can satisfy it. args: ${JSON.stringify(args)}`);
            exisitngStream.resume();
        }
        else {
            log.info(`constructing new MyGotStream with args: ${JSON.stringify(args)}`);
            const _instance = this;
            const newStream = new MyGotStream(this, args.position);
            this._st.push(newStream);
            //add some listeners here to remove it if an error occurred in the mygotstream class.. guess it's already handled
            newStream.startStreaming()
                .then(() => _instance.removeGotStreamInstance(newStream));
            await newStream._mre.wait();
            _instance._em.emit('response', { 
                position: args.position, 
                isSuccessful: newStream.isSuccessful 
            });
        }
    }

    public pumpV2 = (start: number, end: number, rawHttpRequest: http.IncomingMessage) => {
        log.info(`pumpv2 called with ${start}-${end} range`);
        const bytesRequested = end - start + 1;
        let bytesConsumed = 0,
            position = start;
        const _instance = this;
        async function* _startStreamer() {
            let streamBroken = false;
            while (!rawHttpRequest.destroyed && !streamBroken) {
                if (bytesConsumed >= bytesRequested) {
                    log.info(`Guess what! we have reached the conclusion of this stream request.`);
                    break;
                }

                const __data = _instance._bufferArray.tryFetch(position, bytesRequested, bytesConsumed);
                //we should advance the resume if we knew we are about to reach the buffer end
                if (__data) {
                    bytesConsumed = __data.bytesConsumed;
                    position = __data.position;
                    const exisitngStream = _instance._st.find(x => x.CanResolve(position));
                    exisitngStream?.markLastReaderPosition(position);
                    yield __data.data;
                } else {
                    if (_instance._streamArray.length == 0) {
                        log.info(`there are no streamable url available to stream`);
                        throw new Error(`there are no streamable url available to stream`);
                    }
                    _instance._em.emit('pumpresume', { position });
                    var emset = new ManualResetEvent();
                    const onPumpResponse = (args: InternalStreamResponseStreamEventArgs) => {
                        if (args.position === position) {
                            _instance._em.off('response', onPumpResponse);
                            emset.set();
                            if (args.isSuccessful) return;
                            log.info('stream seem to be found broken!!!');
                            streamBroken = true;
                        }
                    }
                    _instance._em.on('response', onPumpResponse);
                    emset.wait(3000);
                }
            }
            rawHttpRequest.destroyed ?
                log.info('request was destroyed') :
                log.info(`Stream pumpV2 ${streamBroken ? 'broken' : 'finished'} with bytesConsumed=${bytesConsumed} and bytesRequested=${bytesRequested}`);

            if (streamBroken) throw new Error('stream broken');
        }

        return Readable.from(_startStreamer());
    }

    public get stats() {
        return this._st.map(x => x.stats);
    }

}
export interface StreamUrlModel { streamUrl: string, headers: Record<string, string>, speedRank: number, docId: string, status: 'HEALTHY' | 'UNHEALTHY' }
interface StreamerRequest {
    imdbId: string, size: number, start: number, end: number, rawHttpMessage: http.IncomingMessage
}
export const streamer = async (req: StreamerRequest) => {
    const existingStream = await InternalStream.create(req);
    return existingStream.pumpV2(req.start, req.end, req.rawHttpMessage);
}