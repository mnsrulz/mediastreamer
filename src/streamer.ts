import { Readable } from 'node:stream';
import * as http from 'http'
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import got, { Request, Response } from 'got';
import prettyBytes from 'pretty-bytes';
import dayjs from 'dayjs'

export const sampleStreamUrl = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_30MB.mp4';
const streams: InternalStream[] = [];

export const parseRangeRequest = (rangeHeader: string | string[] | undefined) => {
    let range: string = '';
    if (rangeHeader) {
        if (Array.isArray(rangeHeader))
            range = rangeHeader[0];
        else
            range = rangeHeader;
    }
    if (range?.startsWith('bytes=')) {
        const kis = range.substring(6).split('-');
        return {
            rangeStart: Number.parseInt(kis[0]),
            rangeEnd: Number.parseInt(kis[1])
        }
    }
}

// async function* startStreamer(resp: Request) {
//     for await (const chunk of resp) {
//         console.log(chunk)
//         yield chunk;
//     }
// }

class MyBuffer {
    _buffer: Buffer;
    _start: number;
    _end: number;
    _serialized: boolean;
    _lastUsed: Date;
    /**
     *
     */
    constructor(buffer: Buffer, start: number, end: number) {
        this._buffer = buffer;
        this._start = start;
        this._end = end;
        this._serialized = false;
        this._lastUsed = new Date();
    }
    serialize(): boolean {
        return true;    //for merging the buffers
    }

    markAsUsedJustNow = () => {
        this._lastUsed = new Date();
    }
}

class MyGotStream {
    public startPosition = 0;
    public position = 0;
    public lastUsed = new Date();
    private gotStream: Request;
    internalstream: InternalStream;
    intervalPointer: NodeJS.Timer;
    constructor(internalstream: InternalStream, initialPosition: number) {
        console.log(`Building a new MyGotStream with initialPosition: ${initialPosition}`);

        this.startPosition = initialPosition;
        this.position = initialPosition;
        this.gotStream = got.stream(internalstream.url, {
            https: { rejectUnauthorized: false },
            headers: {
                'Range': `bytes=${initialPosition}-`
            }
        }).on('response', _res => {

        });

        this.gotStream.on('error', () => { console.error(`Error occurred in the gotStream...`); });
        this.internalstream = internalstream;
        const _stream = this.gotStream;
        const _intance = this;
        //this is to show if the stream break the code behaves appropriately.
        this.intervalPointer = setInterval(() => {
            if (dayjs(_intance.lastUsed).isBefore(dayjs(new Date()).subtract(1, 'minute'))) {
                console.warn(`ok.. forcing the stream to auto destry after idling for more than 1 minute`);
                _stream.destroy();
            }
        }, 20000);
    }
    bus = new EventEmitter();
    // private _sp = 0;
    private _lastReaderPosition = 0;
    public rollin = async () => {
        try {
            const _self = this;
            for await (const chunk of _self.gotStream) {
                const _buf = (chunk as Buffer);
                const selfbuffer = new MyBuffer(_buf, _self.position, _self.position + _buf.byteLength - 1);
                //console.log(`Adding the buffer entry with ${selfbuffer._start} - ${selfbuffer._end}`);
                _self.internalstream._bufferArray.push(selfbuffer);
                _self.position += _buf.byteLength;
                _self.lastUsed = new Date();
                //console.log(`Advancing the position to ${this.position}. Now we have ${_self.internalstream._bufferArray.length} entries in cache.`);
                if (_self.position > _self._lastReaderPosition + 8000000) {    //8MB advance
                    console.log('Pausing the stream as it reaches the threshold')
                    var pm = new Promise(innerResolve => {
                        _self.bus.once('unlocked', innerResolve);
                    });
                    await pm;
                    console.log('resume Event triggered so resuming the stream')
                }
            }
        } catch (error) {
            console.log(`error occurred while iterating the stream...`);
        } finally {
            clearInterval(this.intervalPointer);
        }
    }

    public CanResolve = (position: number) => position >= this.startPosition && position <= this.position;

    public resume = () => {
        this.lastUsed = new Date();
        this._lastReaderPosition = this.position;
        this.bus.emit('unlocked');
    }

    public printStats = () => {
        const { position, lastUsed, startPosition } = this;
        return JSON.stringify({ position, lastUsed, startPosition });
    }
}

interface InternalStreamRequestStreamEventArgs { position: number }

/*
TODO:
1: Allow multiple urls to processed simultaneously
2: Cleanup the array buffer based on some priority. Like start/end range of files should remain there for long time and use lastUsed property
*/

class InternalStream {
    public _bufferArray: MyBuffer[] = [];
    private _em: EventEmitter = new EventEmitter();
    private _st: MyGotStream[] = [];
    url: string;

    constructor(url: string) {
        this.url = url;
        this._em.on('pumpresume', this.streamHandler);
        const _in = this;
        setInterval(() => {
            const _stmaps = _in._st.map(x => {
                return {
                    streamUrl: url,
                    startPosition: x.startPosition,
                    position: x.position,
                    lastUsed: x.lastUsed
                };
            });

            console.log(`
            Printing the following st maps currently in use.
            ${JSON.stringify(_stmaps)}
            And following numbers of buffer arrays: ${_in._bufferArray.length} with size: ${prettyBytes(_in._bufferArray.map(x => x._buffer.length).reduce((x, c) => x + c))}`);
        }, 10000);
    }

    private removeGotStreamInstance = (streamInstance: MyGotStream) => {
        console.log(`removing the gostream with stats: ${streamInstance.printStats()}`)
        this._st = this._st.filter(item => item != streamInstance);
    }

    private streamHandler = async (args: InternalStreamRequestStreamEventArgs) => {
        console.log(`stream handler event received with following data: ${JSON.stringify(args)} and we have ${this._st?.length} streams avaialble`);
        const exisitngStream = this._st.find(x => x.CanResolve(args.position));
        if (exisitngStream) {
            exisitngStream?.resume();
        }
        else {
            const __st = this;
            const newStream = new MyGotStream(this, args.position);
            this._st.push(newStream);
            //add some listeners here to remove it if an error occurred in teh mygotstream class.. guess it's already handled
            newStream.rollin().then(() => __st.removeGotStreamInstance(newStream));
        }
    }

    public pumpV2 = async (start: number, end: number, message: http.IncomingMessage) => {
        console.log(`pumpv2 called with ${start}-${end} range`);
        // await this._signal;
        // console.log('finished stream signal');
        const bytesRequested = end - start + 1; //304-201+1 = 104
        let bytesConsumed = 0,  //0
            position = start;   //201
        const _instance = this;
        async function* _startStreamer() {
            while (!message.destroyed) {
                if (bytesConsumed >= bytesRequested) {
                    console.log(`Guess what! we have reached the conclusion of this stream request.`);
                    break;
                }

                const existingBuffer = _instance._bufferArray.find(x => position >= x._start && position <= x._end);
                if (existingBuffer) {
                    existingBuffer.markAsUsedJustNow();
                    //console.log(`This particular range ${[position, bytesConsumed, bytesRequested]} is partly present in the cache with entry ${existingBuffer._start} - ${existingBuffer._end}.`);
                    const toStartFrom = position - existingBuffer._start;   //201-200 =1
                    const toEnd = toStartFrom + bytesRequested - bytesConsumed;
                    const bufferToSend = existingBuffer._buffer.subarray(toStartFrom, toEnd);  //1,104
                    //console.log(`Buffer sliced from ${toStartFrom} - ${toEnd} with ${bufferToSend.byteLength} bytes`);
                    bytesConsumed += bufferToSend.byteLength;   //99
                    position += bufferToSend.byteLength;    //99+201 = 300
                    yield bufferToSend;
                } else {
                    //console.log('Buffer not present.. going to emit it.')
                    _instance._em.emit('pumpresume', { position } as InternalStreamRequestStreamEventArgs);
                    await delay(100);  //may be utilize event handling here...
                    //console.log(`100ms waiting timeout elapsed...`);
                }
            }
            message.destroyed ?
                console.log('request was destroyed') :
                console.log(`Stream pumpV2 finished with bytesConsumed=${bytesConsumed} and bytesRequested=${bytesRequested}`);
        }

        return new Promise((resolve, reject) => {
            resolve(Readable.from(_startStreamer()));
        });
    }

    // private sliceExistingBuffer(n: number) {
    //     if (this._buffer && this._buffer.byteLength > 0) {
    //         console.log(`slicing the existing buffer with length: ${n} bytes from existing buffer which contains ${this._buffer.byteLength} bytes.`);

    //         const dataToReturn = this._buffer.subarray(0, Math.min(this._buffer.byteLength, n));
    //         this._buffer = this._buffer.subarray(n);

    //         console.log(`returning ${dataToReturn.byteLength} bytes of existing buffer & now new buffer length: ${this._buffer.byteLength}`);
    //         return {
    //             hasSomeData: true,
    //             data: dataToReturn
    //         }
    //     } else {
    //         return {
    //             hasSomeData: false,
    //             data: null
    //         }
    //     }
    // }

    // public async pump(start: number, end: number): Promise<Readable> {
    //     this._isPumping = true;
    //     console.log(`pushing from ${start}-${end}`);    //0-3   4 bytes of data we have to return
    //     await this._signal;
    //     const bytesRequested = end - start + 1; //4bytes of data to send
    //     let bytesConsumed = 0;
    //     const _instance = this;
    //     async function* _startStreamer() {
    //         const existingBufferresponse = _instance.sliceExistingBuffer(bytesRequested);
    //         if (existingBufferresponse.hasSomeData) {
    //             console.log(`found some existing buffer.. will try to flush out it..`);
    //             const lenthOfCurrentChunk = existingBufferresponse.data?.byteLength || 0;
    //             yield existingBufferresponse.data;
    //             bytesConsumed += lenthOfCurrentChunk;
    //         }
    //         if (bytesRequested > bytesConsumed) {
    //             console.log(`Will read from the stream with already consumedBytes: ${bytesConsumed} and originally requested ${bytesRequested} bytes.`);

    //             if (_instance._stream.isPaused()) _instance._stream.resume();

    //             for await (const chunk of _instance._stream) {
    //                 const chunkAsBuffer = chunk as Buffer
    //                 const lenthOfCurrentChunk = chunkAsBuffer.byteLength; //2011011

    //                 if (bytesRequested > (bytesConsumed + lenthOfCurrentChunk)) {
    //                     console.log(`yielding length of chunk: ${lenthOfCurrentChunk}`);
    //                     bytesConsumed += lenthOfCurrentChunk;
    //                     yield chunkAsBuffer;
    //                 } else {
    //                     const remainingBytes = bytesRequested - bytesConsumed;  //2bytes
    //                     if (remainingBytes > 0) {

    //                         console.log(`Looks like we have recvd more data (${lenthOfCurrentChunk}) in buffer.. so sending only ${remainingBytes} bytes...`);
    //                         bytesConsumed += remainingBytes;

    //                         const remainingBuffer = chunkAsBuffer.subarray(0, remainingBytes);
    //                         // const remainingBuffer = Buffer.from(chunkAsBuffer, 0, remainingBytes);
    //                         yield remainingBuffer;
    //                         _instance._buffer = chunkAsBuffer.subarray(remainingBytes);
    //                         console.log(`buffer length remains: ${_instance._buffer.byteLength} bytes`);
    //                         _instance._stream.pause();
    //                         console.log(`pausing stream... with status: ${_instance._stream.isPaused()}`);
    //                     } else {
    //                         if (_instance._buffer) {
    //                             _instance._buffer = Buffer.concat([_instance._buffer, chunkAsBuffer]);
    //                         } else {
    //                             _instance._buffer = chunkAsBuffer;
    //                         }
    //                         //console.log(`concating the reamining buffer: ${chunkAsBuffer.byteLength} with new size: ${_instance._buffer.byteLength}`);                            
    //                     }
    //                 }
    //                 // console.log(bytesConsumed);
    //             }
    //         } else {
    //             console.log(`data was already consumed from the internal buffer..`);

    //         }
    //     }

    //     return new Promise((resolve, reject) => {
    //         resolve(Readable.from(_startStreamer()));
    //     });
    // }
}

interface StreamerRequest { streamUrl: string, start: number, end: number, message: http.IncomingMessage }
export const streamer = async (req: StreamerRequest) => {
    let existingStream = streams.find(s => s.url === req.streamUrl);
    if (!existingStream) {
        existingStream = new InternalStream(req.streamUrl);
        streams.push(existingStream);
    }
    return await existingStream.pumpV2(req.start, req.end, req.message);
}