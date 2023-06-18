import { sort } from 'fast-sort';
import { MyBuffer } from "./MyBuffer.js";
import prettyBytes from 'pretty-bytes';

export class MyBufferCollection {
    private _bufferArray: MyBuffer[] = [];
    private _timerInstance?: NodeJS.Timeout;
    constructor() {
    }
    public tryFetch = (position: number, bytesRequested: number, bytesConsumed: number) => {
        // console.log(`tryFetch called with position: ${position}, bytesConsumed: ${bytesConsumed}`);
        const existingBuffer = this._bufferArray.find(x => position >= x._start && position <= x._end);
        //we should advance the resume if we knew we are about to reach the buffer end
        if (existingBuffer) {
            existingBuffer.markAsUsedJustNow();
            //console.log(`This particular range ${[position, bytesConsumed, bytesRequested]} is partly present in the cache with entry ${existingBuffer._start} - ${existingBuffer._end}.`);
            const toStartFrom = position - existingBuffer._start; //201-200 =1
            const toEnd = toStartFrom + bytesRequested - bytesConsumed;
            const bufferToSend = existingBuffer._buffer.subarray(toStartFrom, toEnd); //1,104

            //console.log(`Buffer sliced from ${toStartFrom} - ${toEnd} with ${bufferToSend.byteLength} bytes`);
            bytesConsumed += bufferToSend.byteLength; //99
            position += bufferToSend.byteLength; //99+201 = 300
            return { data: bufferToSend, position, bytesConsumed };
        }
    };
    //setup some timer to consolidate the buffer into single ones.
    public push = (d: MyBuffer) => {
        this._bufferArray.push(d);
        clearTimeout(this._timerInstance);
        this._timerInstance = setTimeout(this.consolidateBuffers, 10000);
    };

    public consolidateBuffers = () => {
        const existingArray = this._bufferArray;
        const ordered = sort(existingArray).asc(b => b._start);
        let newBuffArray: MyBuffer[] = [];
        let last: MyBuffer | null = null;
        let lastBufferPool: Buffer[] = [];
        let lastBufferPoolSize = 0;
        console.log(`consolidation started, there are ${this.bufferArrayCount} instances...`);
        for (const item of ordered) {
            if (last) {
                //if the lastbuffer exceeds 8MB start a new one as it's easy to serialize it
                if ((lastBufferPoolSize + item._buffer.byteLength) < 8000000 && last._end == item._start - 1) {
                    last._end = item._end;
                } else {
                    last._buffer = Buffer.concat(lastBufferPool);
                    newBuffArray.push(last);
                    lastBufferPool = [];
                    last = item;
                    lastBufferPoolSize = 0;
                }
            } else {
                last = item;
            }
            lastBufferPool.push(item._buffer);
            lastBufferPoolSize += item._buffer.byteLength;
        }

        if (last) {
            last._buffer = Buffer.concat(lastBufferPool);
            newBuffArray.push(last);
        }

        this._bufferArray = newBuffArray;
        console.log(`consolidation done with ${this.bufferArrayCount} instances!`);
    };

    public get bufferArrayCount() {
        return this._bufferArray.length;
    }

    public get bufferSize() {
        return this._bufferArray.map(x => x._buffer.length).reduce((x, c) => x + c, 0);
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
