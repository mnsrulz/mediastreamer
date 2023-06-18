import { Readable } from 'node:stream';
import * as http from 'http'
import { EventEmitter } from 'node:events';
import got, { Request, Response } from 'got';
import prettyBytes from 'pretty-bytes';
import dayjs from 'dayjs'
import { pEvent } from 'p-event';
import { ManualResetEvent } from './ManualResetEvent.js';
import { MyBufferCollection } from './MyBufferCollection.js';
import { MyBuffer } from './MyBuffer.js';
import { getLinks, requestRefresh } from './apiClient.js';
import { sort } from 'fast-sort';

const parseContentLengthFromRangeHeader = (headerValue: string | null): number | undefined => {
    if (headerValue) {
        return parseInt(headerValue.split('/').pop() || '0');
    }
}

export const sampleStreamUrl = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_30MB.mp4';
const globalStreams: InternalStream[] = [];

export const clearBuffers = () => {
    const maxSizeBuffer = 200 * 1000 * 1000;    //200MB buffer
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
        console.log(`found ${cleanupItems} items to cleanup ${prettyBytes(cleanupSize)}`);
        buffersToClean.forEach(x => x.bufferCollection.clearBuffers(x.bufferIds));
    } else
        console.log(`nothing to cleanup`);
}

export const currentStats = () => {
    const _stmaps = globalStreams.map(x => {
        return {
            imdbId: x._imdbId,
            size: prettyBytes(x._size),
            bufferRange: x._bufferArray.bufferRange,
            numberOfStreams: x.MyGotStreamCount,
            bufferArrayLength: x._bufferArray.bufferArrayCount,
            bufferArraySize: prettyBytes(x._bufferArray.bufferSize)
        };
    });
    return _stmaps;
}


class MyGotStream {
    public startPosition = 0;
    public currentPosition = 0;
    public lastUsed = new Date();
    private _gotStream: Request;
    _internalstream: InternalStream;
    _mre = ManualResetEvent.createNew();
    intervalPointer: NodeJS.Timer;
    bus = new EventEmitter();
    private _lastReaderPosition = 0;
    isSuccessful = false;
    private _drainRequested = false;
    _streamUrlModel: StreamUrlModel;

    constructor(internalstream: InternalStream, initialPosition: number) {
        this._internalstream = internalstream;

        this._streamUrlModel = sort(internalstream._streamArray).desc(x => x.speedRank)[0];

        console.log(`Buildings a new MyGotStream ${new URL(this._streamUrlModel.streamUrl).host} having rank ${this._streamUrlModel.speedRank
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
                    console.log(`content length mismatch: E/A ${internalstream._size}/${potentialContentLength}`);
                } else {
                    console.info(`successful stream acquired with matching content length ${potentialContentLength}`);
                    _i.isSuccessful = true;
                }
            } else {
                console.log(`non successfull response code received: ${response.statusCode}`);
            }
            if (!_i.isSuccessful) {
                internalstream._streamArray = internalstream._streamArray.filter(x => x != this._streamUrlModel);
                requestRefresh(this._streamUrlModel.docId);
            }
            _i._mre.set();
        }).on('error', () => {
            console.log(`error occurred during the gotstream`);
            _i._mre.set();
            // internalstream._streamArray = internalstream._streamArray.filter(x => x != this._streamUrlModel);
            // requestRefresh(this._streamUrlModel.docId);
        });

        //this is to show if the stream break the code behaves appropriately.
        this.intervalPointer = setInterval(() => {
            if (dayjs(_i.lastUsed).isBefore(dayjs(new Date()).subtract(1, 'minute'))) {
                console.log(`ok.. forcing the stream to auto destroy after idling for more than 1 minute`);
                _i.drainIt();
            }
        }, 20000);
    }

    public startStreaming = async () => {
        const _self = this;
        // const streamSpeedTest = new streamspeed();
        // let speedTestTimer: NodeJS.Timer | null = null;
        try {
            let ispaused = false;
            await this._mre.wait();
            if (!_self.isSuccessful) throw new Error(`non successfull stream response recvd...`);
            console.log(`yay! we found a good stream... traversing it..`);
            // streamSpeedTest.add(_self._gotStream);
            // speedTestTimer = setInterval(() => {
            //     if (ispaused) return;
            //     console.log(`get speed for current stream: ${streamSpeedTest.getSpeed()}`);
            // }, 1000);

            for await (const chunk of _self._gotStream) {
                const _buf = (chunk as Buffer);
                const selfbuffer = new MyBuffer(_buf, _self.currentPosition, _self.currentPosition + _buf.byteLength - 1);
                _self._internalstream._bufferArray.push(selfbuffer);
                _self.currentPosition += _buf.byteLength;
                _self.lastUsed = new Date();
                if (!_self._drainRequested && _self.currentPosition > _self._lastReaderPosition + 8000000) {    //8MB advance
                    ispaused = true;
                    // console.log(`get speed for current stream: ${streamSpeedTest.getSpeed()}`);
                    console.log('Pausing the stream as it reaches the threshold')
                    await pEvent(_self.bus, 'unlocked');
                    console.log('resume Event triggered so resuming the stream')
                    ispaused = false;
                }
            }
        } catch (error) {
            _self._drainRequested ?
                console.log(`stream ended as drain requested`) :
                console.log(`error occurred while iterating the stream...`);    //in case of errors the system will just create a new stream automatically.
        } finally {
            clearInterval(this.intervalPointer);
            //if (speedTestTimer) clearInterval(speedTestTimer);
            // try {
            //     console.log(`removing the stream from the speed test...`);
            //     this._gotStream && streamSpeedTest.remove(this._gotStream);
            // } catch (error) {
            //     console.log(`error occurred while removing the stream from the speed test...`);
            // }
        }
    }

    public CanResolve = (position: number) => position >= this.startPosition && position <= this.currentPosition;

    public resume = () => {
        this.lastUsed = new Date();
        this._lastReaderPosition = this.currentPosition;
        this.bus.emit('unlocked');
    }

    public drainIt = () => {
        console.log(`drain requested so destryoing the existing stream...`);
        this._drainRequested = true;
        this._gotStream.destroy();
        this.bus.emit('unlocked');
    }

    public printStats = () => {
        const { currentPosition: position, lastUsed, startPosition } = this;
        return JSON.stringify({ position, lastUsed, startPosition });
    }
}

interface InternalStreamRequestStreamEventArgs { position: number }

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

class InternalStream {
    private _refreshRequested = false;
    _bufferArray = new MyBufferCollection();
    private _em: EventEmitter = new EventEmitter();
    private _st: MyGotStream[] = [];
    _imdbId: string;
    _streamArray: StreamUrlModel[];
    _size: number;

    queueRefresh() {
        if (this._refreshRequested) return;
        this._refreshRequested = true;
        setTimeout(async () => {
            try {
                const tempstreams = await InternalStream.acquireStreams(this._imdbId, this._size);
                this.mergeStream(tempstreams);
            } catch (error) {
                console.log(`error occurred while refreshing the streams for imdb: ${this._imdbId}, size: ${this._size}`);
            }
            this._refreshRequested = false;
        }, 30000);   //after 30 seconds perform refresh of links
    }
    mergeStream(streams: StreamUrlModel[]) {
        const docIds = streams.map(x => x.docId);
        this._streamArray = [...streams, ...this._streamArray.filter(x => !docIds.includes(x.docId))];

        const fastestStream = sort(this._streamArray).desc(x => x.speedRank)[0];
        console.log(`merging streams... and finding any new better stream available`);
        for (const currentgotstream of this._st) {
            if (currentgotstream._streamUrlModel.speedRank < fastestStream.speedRank) {
                console.log(`found a new stream with rank ${fastestStream.speedRank} better than the existing ${currentgotstream._streamUrlModel.speedRank}..`);
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
            existingStream.queueRefresh();  //silent refresh of the streams
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
        console.log(`removing the gostream with stats: ${streamInstance.printStats()}`)
        this._st = this._st.filter(item => item != streamInstance);
    }

    private streamHandler = async (args: InternalStreamRequestStreamEventArgs) => {
        console.log(`stream handler event received with following data: ${JSON.stringify(args)} and we have ${this._st?.length} streams avaialble`);
        const exisitngStream = this._st.find(x => x.CanResolve(args.position));
        if (exisitngStream) {
            console.log(`existing stream found which can satisfy it. args: ${JSON.stringify(args)}`);
            exisitngStream.resume();
        }
        else {
            console.log(`constructing new MyGotStream with args: ${JSON.stringify(args)}`);
            const _instance = this;
            const newStream = new MyGotStream(this, args.position);
            this._st.push(newStream);
            //add some listeners here to remove it if an error occurred in teh mygotstream class.. guess it's already handled
            newStream.startStreaming()
                .then(() => _instance.removeGotStreamInstance(newStream));
            await newStream._mre.wait();
            _instance._em.emit(`response-${args.position}`, {
                isSuccessful: newStream.isSuccessful
            });
        }
    }

    public pumpV2 = (start: number, end: number, rawHttpRequest: http.IncomingMessage) => {
        console.log(`pumpv2 called with ${start}-${end} range`);
        const bytesRequested = end - start + 1;
        let bytesConsumed = 0,
            position = start;
        const _instance = this;
        async function* _startStreamer() {
            let streamBroken = false;
            while (!rawHttpRequest.destroyed && !streamBroken) {
                if (bytesConsumed >= bytesRequested) {
                    console.log(`Guess what! we have reached the conclusion of this stream request.`);
                    break;
                }

                const __data = _instance._bufferArray.tryFetch(position, bytesRequested, bytesConsumed);
                //we should advance the resume if we knew we are about to reach the buffer end
                if (__data) {
                    bytesConsumed = __data.bytesConsumed;
                    position = __data.position;
                    yield __data.data;
                } else {
                    if (_instance._streamArray.length == 0) {
                        console.log(`there are no streamable url available to stream`);
                        throw new Error(`there are no streamable url available to stream`);
                    }
                    _instance._em.emit('pumpresume', { position } as InternalStreamRequestStreamEventArgs);
                    try {
                        const resultOfPEvent: { isSuccessful: boolean } = await pEvent(_instance._em, `response-${position}`, {
                            timeout: 3000
                        });
                        if (!resultOfPEvent.isSuccessful) {
                            console.log('stream seem to be found broken!!!');
                            streamBroken = true;
                        }
                    } catch (error) {
                        //ignore errors as they are mostly of timeout error
                    }
                }
            }
            rawHttpRequest.destroyed ?
                console.log('request was destroyed') :
                console.log(`Stream pumpV2 ${streamBroken ? 'broken' : 'finished'} with bytesConsumed=${bytesConsumed} and bytesRequested=${bytesRequested}`);

            if (streamBroken) throw new Error('stream broken');
        }

        return Readable.from(_startStreamer());
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