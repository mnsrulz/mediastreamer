

export class MyBuffer {
    _buffer: Buffer;
    _start: number;
    _end: number;
    _serialized: boolean;
    _lastUsed: Date;
    _timesUsed = 0;
    constructor(buffer: Buffer, start: number, end: number) {
        this._buffer = buffer;
        this._start = start;
        this._end = end;
        this._serialized = false;
        this._lastUsed = new Date();
    }
    serialize(): boolean {
        return true; //for merging the buffers
    }

    markAsUsedJustNow = () => {
        this._timesUsed++;
        this._lastUsed = new Date();
    };
}
