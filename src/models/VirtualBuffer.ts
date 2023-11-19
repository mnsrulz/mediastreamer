import prettyBytes from 'pretty-bytes';
import { log } from '../app.js';

export class VirtualBuffer {
    _additionalBuffer: Buffer[] = [];
    append(d: Buffer) {
        this._additionalBuffer.push(d);
        this._end += d.byteLength;
        this._length += d.byteLength;
    }
    private _buffer: Buffer;
    private _serialized: boolean;
    private _lastUsed: Date;
    private _start: number;
    private _end: number;
    private _timesUsed = 0;
    private _isClosed = false;
    private _length = 0;
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

    private markAsUsedJustNow = () => {
        this._timesUsed++;
        this._lastUsed = new Date();
    };

    public get lastUsed() {
        return this._lastUsed;
    }

    public get bufferId() {
        return `${this._start}-${this._end}`;
    }

    public get length() {
        return this._length;
    }

    public get range() {
        return { start: this._start, end: this._end };
    }

    markAsClosed = () => {
        this._isClosed = true;
    };

    public get buffer(): Buffer {
        this.markAsUsedJustNow();

        if (this._additionalBuffer.length > 0) {
            //buffer concat is very expensive operation.. so here we are consolidating it at the time of actual read
            const _additionalBufferCount = this._additionalBuffer.length;
            const stime = performance.now();
            this._buffer = Buffer.concat([this._buffer, ...this._additionalBuffer]);
            this._additionalBuffer = [];
            const ftime = performance.now();
            const elapsed = (ftime - stime).toFixed(0);
            log.info(`consolidated ${_additionalBufferCount + 1} buffer items worth of ${prettyBytes(this._length)} in ${elapsed} ms!`);
        }
        return this._buffer;
    }
}
