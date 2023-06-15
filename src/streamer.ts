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

const parseContentLengthFromRangeHeader = (headerValue: string | null): number | undefined => {
    if (headerValue) {
        return parseInt(headerValue.split('/').pop() || '0');
    }
}

export const sampleStreamUrl = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_30MB.mp4';
const streams: InternalStream[] = [];

export const currentStats = () => {
    const _stmaps = streams.map(x => {
        return {
            streamUrl: x.url,
            //kk: x.headers,
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

    constructor(internalstream: InternalStream, initialPosition: number) {
        this._internalstream = internalstream;

        console.log(`Buildings a new MyGotStream ${new URL(internalstream.url).host} with initialPosition: ${initialPosition}`);
        const _i = this;
        _i.startPosition = initialPosition;
        _i.currentPosition = initialPosition;
        _i._lastReaderPosition = initialPosition;

        const _internalHeaders = internalstream.headers || {};
        _internalHeaders['Range'] = `bytes=${_i.currentPosition}-`;

        this._gotStream = got.stream(internalstream.url, {
            https: { rejectUnauthorized: false },
            headers: _internalHeaders,
            throwHttpErrors: true
        }).on('response', (response: Response) => {
            // console.log(`inside response event with status: ${response.statusCode}`);
            let _result = false;
            if (response.statusCode >= 200 && response.statusCode < 300) {
                const contentLengthHeader = parseInt(response.headers['content-length'] || '0');
                const potentialContentLength = parseContentLengthFromRangeHeader(response.headers['content-range'] || '')
                    || contentLengthHeader;

                if (internalstream._size !== potentialContentLength) {
                    throw new Error(`content length mismatch: E/A ${internalstream._size}/${potentialContentLength}`);
                } else {
                    console.info(`successful stream acquired with matching content length ${potentialContentLength}`);
                    _i.isSuccessful = true;
                    _result = true;
                }
            }
            _i._mre.set();
        }).on('error', () => {
            _i._mre.set();
        });

        //this is to show if the stream break the code behaves appropriately.
        this.intervalPointer = setInterval(() => {
            if (dayjs(_i.lastUsed).isBefore(dayjs(new Date()).subtract(1, 'minute'))) {
                console.warn(`ok.. forcing the stream to auto destroy after idling for more than 1 minute`);
                _i.drainIt();
                _i._gotStream.destroy();
            }
        }, 20000);

    }

    public startStreaming = async () => {
        const _self = this;
        try {
            await this._mre.wait();
            console.log(`yay! we found a good stream... traversing it..`);

            for await (const chunk of _self._gotStream) {
                const _buf = (chunk as Buffer);
                const selfbuffer = new MyBuffer(_buf, _self.currentPosition, _self.currentPosition + _buf.byteLength - 1);
                _self._internalstream._bufferArray.push(selfbuffer);
                _self.currentPosition += _buf.byteLength;
                _self.lastUsed = new Date();
                if (!_self._drainRequested && _self.currentPosition > _self._lastReaderPosition + 8000000) {    //8MB advance
                    console.log('Pausing the stream as it reaches the threshold')
                    await pEvent(_self.bus, 'unlocked');
                    console.log('resume Event triggered so resuming the stream')
                }
            }
        } catch (error) {
            _self._drainRequested ?
                console.log(`stream ended as drain requested`) :
                console.log(`error occurred while iterating the stream...`);    //in case of errors the system will just create a new stream automatically.
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

    public drainIt = () => {
        this._drainRequested = true;
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
    _bufferArray = new MyBufferCollection();

    private _em: EventEmitter = new EventEmitter();
    private _st: MyGotStream[] = [];
    url: string;
    headers: Record<string, string>;
    _size: number;

    /*
    Look for an existing stream which can satisfy the request. If not create one.
    */
    public static create = (req: StreamerRequest) => {
        let existingStream = streams.find(s => s.url === req.streamUrl);
        if (!existingStream) {
            existingStream = new InternalStream(req.streamUrl, req.size, req.headers);
            streams.push(existingStream);
        }
        return existingStream;
    }


    public get MyGotStreamCount() {
        return this._st.length;
    }

    constructor(url: string, size: number, headers: Record<string, string>) {
        this.url = url;
        this.headers = headers;
        this._size = size;
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
            exisitngStream.resume();
        }
        else {
            const __st = this;
            const newStream = new MyGotStream(this, args.position);
            this._st.push(newStream);
            //add some listeners here to remove it if an error occurred in teh mygotstream class.. guess it's already handled
            newStream.startStreaming()
                .then(() => __st.removeGotStreamInstance(newStream));
            await newStream._mre.wait();
            __st._em.emit(`response-${args.position}`, {
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
                    _instance._em.emit('pumpresume', { position } as InternalStreamRequestStreamEventArgs);
                    try {
                        const resultofpevent: { isSuccessful: boolean } = await pEvent(_instance._em, `response-${position}`, {
                            timeout: 3000
                        });
                        if (!resultofpevent.isSuccessful) {
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

interface StreamerRequest { streamUrl: string, size: number, headers: Record<string, string>, start: number, end: number, rawHttpMessage: http.IncomingMessage }
export const streamer = (req: StreamerRequest) => {
    const existingStream = InternalStream.create(req);
    return existingStream.pumpV2(req.start, req.end, req.rawHttpMessage);
}