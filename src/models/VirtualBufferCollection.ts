import prettyBytes from 'pretty-bytes';
import config from '../config.js';
import { VirtualBuffer } from './VirtualBuffer.js';

export class VirtualBufferCollection {
    private _bufferArray: VirtualBuffer[] = [];
    private _maxBufferSize;
    constructor(maxBufferSize = config.maxChunkSizeMB * 1024 * 1024) {
        this._maxBufferSize = maxBufferSize;
    }
    public tryFetch = (position: number, bytesRequested: number, bytesConsumed: number) => {
        const existingBuffer = this.existingBufferWhichCanSatisfyPosition(position);
        //we should advance the resume if we knew we are about to reach the buffer end
        if (existingBuffer) {
            //console.log(`This particular range ${[position, bytesConsumed, bytesRequested]} is partly present in the cache with entry ${existingBuffer._start} - ${existingBuffer._end}.`);
            const toStartFrom = position - existingBuffer.range.start; //201-200 =1
            const toEnd = toStartFrom + bytesRequested - bytesConsumed;
            const bufferToSend = existingBuffer.buffer.subarray(toStartFrom, toEnd)
                .subarray(0, config.chunkSizeBytes); //1,104

            //console.log(`Buffer sliced from ${toStartFrom} - ${toEnd} with ${bufferToSend.byteLength} bytes`);
            bytesConsumed += bufferToSend.byteLength; //99
            position += bufferToSend.byteLength; //99+201 = 300
            return { data: bufferToSend, position, bytesConsumed };
        }
    };

    /** enqueue the buffer to the buffer collection */
    public push = (buffer: Buffer, position: number) => {
        /*
        start position should not be negative...
        should not exceed the length of buffer size to 8mb
        get the item whose end is equals to statrt -1 
        */

        if (position < 0) throw new Error('position should not be negative');

        //consider using a map for better performance
        const existingBuffer = this._bufferArray.find(x => (x.length + buffer.byteLength) < this._maxBufferSize && (x.range.end + 1) == position);
        if (existingBuffer) {
            existingBuffer.append(buffer);
        } else {
            this._bufferArray.push(new VirtualBuffer(buffer, position, position + buffer.byteLength - 1));
        }
    };

    /** returns the current length of virtual buffer element*/
    public get bufferArrayCount() {
        return this._bufferArray.length;
    }

    /**returns the size of the buffer collection*/
    public get bufferSize() {
        return this._bufferArray.map(x => x.length).reduce((x, c) => x + c, 0);
    }

    public get bufferRange() {
        let range = [];
        for (const b of this._bufferArray) {
            range.push({
                start: b.range.start,
                end: b.range.end,
                bytesLength: b.length,
                bytesLengthHuman: prettyBytes(b.length),
                lastUsed: b.lastUsed
            });
        }
        return range;
    }

    public clearBuffers = (bufferIds: string[]) => {
        this._bufferArray = this._bufferArray.filter(x => !bufferIds.includes(x.bufferId));
    }

    public get bufferRangeIds() {
        let range = [];
        for (const b of this._bufferArray) {
            range.push({
                bufferId: b.bufferId,
                lastUsed: b.lastUsed,
                bytesLength: b.length
            });
        }
        return range;
    }

    /**returns the existing buffer which can satisify the position */
    public existingBufferWhichCanSatisfyPosition = (position: number) => {
        return this._bufferArray.find(x => position >= x.range.start && position <= x.range.end);
    }
}