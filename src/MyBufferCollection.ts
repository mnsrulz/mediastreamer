import prettyBytes from 'pretty-bytes';
import { log } from './app.js';

export class MyBufferCollection {
    private _bufferArray: MyBuffer[] = [];
    private _timerInstance?: NodeJS.Timeout;
    private _maxBufferSize;
    constructor(maxBufferSize = 8000000) {
        this._maxBufferSize = maxBufferSize;
    }
    public tryFetch = (position: number, bytesRequested: number, bytesConsumed: number) => {
        // console.log(`tryFetch called with position: ${position}, bytesConsumed: ${bytesConsumed}`);
        //force consolidation if there are more than 1000 items
        //        if (this._bufferArray.length > 1000) this.consolidateBuffers();

        const existingBuffer = this._bufferArray.find(x => position >= x._start && position <= x._end);
        //we should advance the resume if we knew we are about to reach the buffer end
        if (existingBuffer) {
            existingBuffer.markAsUsedJustNow();
            //console.log(`This particular range ${[position, bytesConsumed, bytesRequested]} is partly present in the cache with entry ${existingBuffer._start} - ${existingBuffer._end}.`);
            const toStartFrom = position - existingBuffer._start; //201-200 =1
            const toEnd = toStartFrom + bytesRequested - bytesConsumed;
            const bufferToSend = existingBuffer.buffer.subarray(toStartFrom, toEnd); //1,104

            //console.log(`Buffer sliced from ${toStartFrom} - ${toEnd} with ${bufferToSend.byteLength} bytes`);
            bytesConsumed += bufferToSend.byteLength; //99
            position += bufferToSend.byteLength; //99+201 = 300
            return { data: bufferToSend, position, bytesConsumed };
        }
    };
    //setup some timer to consolidate the buffer into single ones.
    public push = (buffer: Buffer, position: number) => {
        /*
        start position should be greater than zero...
        should not exceed the length of buffer size to 8mb
        get the item whose end is equals to statrt -1 
        */

        //consider using a map for better performance
        const existingBuffer = this._bufferArray.find(x => (x._length + buffer.byteLength) < this._maxBufferSize && (x._end + 1) == position);
        if (existingBuffer) {
            existingBuffer.append(buffer);
        } else {
            this._bufferArray.push(new MyBuffer(buffer, position, position + buffer.byteLength - 1));
        }

        // clearTimeout(this._timerInstance);
        // this._timerInstance = setTimeout(this.consolidateBuffers, 10000);
    };

    // public consolidateBuffers = () => {
    //     const stime = performance.now();
    //     const existingArray = this._bufferArray;
    //     const ordered = sort(existingArray).asc(b => b._start);
    //     let newBuffArray: MyBuffer[] = [];
    //     let last: MyBuffer | null = null;
    //     let lastBufferPool: Buffer[] = [];
    //     let lastBufferPoolSize = 0;
    //     const bufferArrayCount = this.bufferArrayCount;
    //     //log.info(`consolidation started, there are ${this.bufferArrayCount} instances...`);
    //     for (const item of ordered) {
    //         if (last) {
    //             //if the lastbuffer exceeds 8MB start a new one as it's easy to serialize it
    //             if ((lastBufferPoolSize + item._length) < 8000000 && last._end == item._start - 1) {
    //                 last._end = item._end;
    //             } else {
    //                 last._buffer = Buffer.concat(lastBufferPool);
    //                 newBuffArray.push(last);
    //                 lastBufferPool = [];
    //                 last = item;
    //                 lastBufferPoolSize = 0;
    //             }
    //         } else {
    //             last = item;
    //         }
    //         lastBufferPool.push(item._buffer);
    //         lastBufferPoolSize += item._buffer.byteLength;
    //     }

    //     if (last) {
    //         last._buffer = Buffer.concat(lastBufferPool);
    //         newBuffArray.push(last);
    //     }

    //     this._bufferArray = newBuffArray;
    //     const ftime = performance.now();
    //     log.info(`consolidated ${bufferArrayCount} buffer items to ${this.bufferArrayCount} items in ${ftime - stime} ms!`);
    // };

    public get bufferArrayCount() {
        return this._bufferArray.length;
    }

    public get bufferSize() {
        return this._bufferArray.map(x => x._length).reduce((x, c) => x + c, 0);
    }


    public get bufferRange() {
        let range = [];
        for (const b of this._bufferArray) {
            range.push({
                start: b._start,
                end: b._end,
                bytesLength: b._end - b._start + 1,
                bytesLengthHuman: prettyBytes(b._end - b._start + 1),
                lastUsed: b._lastUsed
            });
        }
        return range;
    }

    public clearBuffers(bufferIds: string[]) {
        this._bufferArray = this._bufferArray.filter(x => !bufferIds.includes(x.bufferId));
    }


    public get bufferRangeIds() {
        let range = [];
        for (const b of this._bufferArray) {
            range.push({
                bufferId: b.bufferId,
                lastUsed: b._lastUsed,
                bytesLength: b._end - b._start + 1
            });
        }
        return range;
    }

}


class MyBuffer {
    _additionalBuffer: Buffer[] = [];
    append(d: Buffer) {
        this._additionalBuffer.push(d);
        this._end += d.byteLength;
        this._length += d.byteLength;
    }
    private _buffer: Buffer;
    _start: number;
    _end: number;
    _serialized: boolean;
    _lastUsed: Date;
    _timesUsed = 0;
    _isClosed = false;
    _length = 0;
    constructor(buffer: Buffer, start: number, end: number) {
        this._buffer = buffer;
        this._start = start;
        this._end = end;
        this._serialized = false;
        this._lastUsed = new Date();
        this._length = buffer.byteLength;
    }
    serialize(): boolean {
        return true; //for merging the buffers
    }

    markAsUsedJustNow = () => {
        this._timesUsed++;
        this._lastUsed = new Date();
    };


    public get bufferId() {
        return `${this._start}-${this._end}`;
    }
    markAsClosed = () => {
        this._isClosed = true;
    }

    public get buffer(): Buffer {
        if (this._additionalBuffer.length > 0) {
            //buffer concat is very expensive operation.. so here we are consolidating it at the time of actual read
            const _additionalBufferCount = this._additionalBuffer.length
            const stime = performance.now();
            this._buffer = Buffer.concat([this._buffer, ...this._additionalBuffer]);
            this._additionalBuffer = [];
            const ftime = performance.now();
            log.info(`consolidated ${_additionalBufferCount + 1} buffer items worth of ${prettyBytes(this._length)} in ${ftime - stime} ms!`);
        }
        return this._buffer;
    }

}
