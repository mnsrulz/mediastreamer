import { EventEmitter } from 'node:events';
import got, { Request, Response } from 'got';
import dayjs from 'dayjs';
import { pEvent } from 'p-event';
import { ManualResetEvent } from './utils/ManualResetEvent.js';
import { log } from './app.js';
import { parseContentLengthFromRangeHeader } from './utils/utils.js';
import config from './config.js';
import { TypedEventEmitter } from './TypedEventEmitter.js';
import { StreamUrlModel } from './models/StreamUrlModel.js';
import { VirtualBufferCollection } from './models/VirtualBufferCollection.js';
type ResumableStreamDataEventArgs = { position: number, buffer: Buffer }
type ResumableStreamEventTypes = { 'data': [args: ResumableStreamDataEventArgs], 'error': [arg1: Error] }
const BufferSnapshotMaxItems = 10;  //buffer snapshot max items for finding the stream health

export const streamerv2 = async (streamUrlModel: StreamUrlModel, bf: VirtualBufferCollection, size: number, initialPosition: number) => {
    log.info(`Building a new '${new URL(streamUrlModel.streamUrl).host}' stream with rank ${streamUrlModel.speedRank} offset: ${initialPosition}`);

    const _internalHeaders = streamUrlModel.headers || {};
    _internalHeaders['Range'] = `bytes=${initialPosition}-`;

    return new Promise<ResumableStream>((res, rej) => {
        const _gotStream = got.stream(streamUrlModel.streamUrl, {
            https: { rejectUnauthorized: false },
            headers: _internalHeaders
        }).on('response', (response: Response) => {
            const contentLengthHeader = parseInt(response.headers['content-length'] || '0');
            const potentialContentLength = parseContentLengthFromRangeHeader(response.headers['content-range'] || '')
                || contentLengthHeader;

            if (size !== potentialContentLength) {
                rej(new Error(`Content Length mismatch: Expected/Actual ${size}/${potentialContentLength}`));
            } else {
                const s = new ResumableStream(_gotStream, initialPosition, bf, streamUrlModel)
                res(s);
            }
        }).on('error', rej);
    });
}

/*
Stream responsible for building a new stream and emitting the data in an effective manner
*/
export class ResumableStream {
    public startPosition = 0;
    private _currentPosition = 0;
    private _lastReaderPosition = 0;
    public lastUsed = new Date();
    private _drainRequested = false;
    private _gotStream: Request;
    private _readAheadExceeded = false;
    private _mre = ManualResetEvent.createNew();
    private _bf: VirtualBufferCollection;
    private _intervalPointer: NodeJS.Timer;
    private _bufferSnapshotIntervalPointer: NodeJS.Timer;
    private _bufferSnapshot: { ts: Date, readAheadBufferSize: number }[] = []
    private _speedSnapshot: { ts: Date, bytesDownloaded: number }[] = []
    private _slowStreamHandled = false;   //use this in conjuction with speed_bps and buffer health
    private _bytesDownloaded = 0;
    private _forceEndPosition = Number.MAX_VALUE;
    //bus = new EventEmitter();
    _streamUrlModel: StreamUrlModel;


    constructor(stream: Request, initialPosition: number, bf: VirtualBufferCollection, um: StreamUrlModel) {
        this.startPosition = initialPosition;
        this._currentPosition = initialPosition;
        this._lastReaderPosition = initialPosition;
        this._gotStream = stream;
        this._bf = bf;
        this._streamUrlModel = um;

        //this is to show if the stream break the code behaves appropriately.
        //move this to global monitoring.. these sort of actions can be decoupled
        const _i = this;
        this._intervalPointer = setInterval(() => {
            if (dayjs(_i.lastUsed).isBefore(dayjs(new Date()).subtract(10, 'minute'))) {
                log.warn(`ok.. forcing the stream to auto destroy after idling for more than 10 minute`);
                _i.drainIt();
            }
        }, 20000);

        this._bufferSnapshotIntervalPointer = setInterval(this.performBufferSnapshot, 1000);
    }

    private performBufferSnapshot = () => {
        const _i = this;
        const ts = new Date()
        _i._bufferSnapshot.push({ ts, readAheadBufferSize: _i._currentPosition - _i._lastReaderPosition });
        _i._speedSnapshot.push({ ts, bytesDownloaded: _i._bytesDownloaded })

        if (_i._bufferSnapshot.length > BufferSnapshotMaxItems) {
            _i._bufferSnapshot.shift();
        }

        if (_i._speedSnapshot.length > BufferSnapshotMaxItems) {
            _i._speedSnapshot.shift();
        }
    }

    public startStreaming = async () => {
        try {
            log.info(`yay! we found a good stream... traversing it..`);
            for await (const chunk of this._gotStream) {
                if (this._drainRequested) break;

                const _buf = (chunk as Buffer);
                this._bf.push(_buf, this._currentPosition);      //_self.emit('data', { buffer: _buf, position: _self.currentPosition });
                this._currentPosition += _buf.byteLength; this._bytesDownloaded += _buf.byteLength;
                this.lastUsed = new Date();

                if (this._bf.existingBufferWhichCanSatisfyPosition(this._currentPosition)) {
                    log.info(`there's already a buffer which can satisfy upcomping buffer position '${this._currentPosition}' so breaking this stream.`);
                    break;
                }

                if (this._currentPosition >= this._forceEndPosition) {
                    log.info(`force end position (${this._forceEndPosition}) detected for this stream at buffer position '${this._currentPosition}' so breaking this stream.`);
                    break;
                }

                while (!this._drainRequested && this._currentPosition > this._lastReaderPosition + (config.readAheadSizeMB * 1024 * 1024)) { //advance bytes
                    this._readAheadExceeded = true;
                    //await pEvent(this.bus, 'unlocked');    //do we need a bus?
                    log.info(`stream read ahead exhausted. Pausing for a while`);
                    this._mre.reset();
                    await this._mre.wait();
                    this._readAheadExceeded = false;
                }
            }
        } catch (error) {
            this._drainRequested ?
                log.info(`stream ended as drain requested. Actual Err: ${(error as Error)?.message}`) :
                log.error(`error occurred while iterating the stream. Actual Err: ${(error as Error)?.message}`); //in case of errors the system will just create a new stream automatically.
        } finally {
            clearInterval(this._intervalPointer);
            clearInterval(this._bufferSnapshotIntervalPointer);
        }
    };

    public CanResolve = (position: number) => position >= this.startPosition && position <= this._currentPosition;

    public resume = () => {
        this.lastUsed = new Date();
        this._lastReaderPosition = this._currentPosition;
        //this.bus.emit('unlocked');
        this._mre.set();
    };

    //maybe a better name needed but this is helpful to advance the position of the stream if it's in read exhaust mode
    public markLastReaderPosition = (position: number) => {
        if (this._lastReaderPosition < position) {
            this._lastReaderPosition = position;
            //this.bus.emit('unlocked');
            this._mre.set();
        }
    };

    public drainIt = () => {
        log.info(`drain requested so destryoing the existing stream...`);
        this._drainRequested = true;
        this._gotStream.destroy();
        //this.bus.emit('unlocked');
        this._mre.set();
    };


    public get slowStreamHandled() {
        return this._slowStreamHandled
    }

    public markSlowStreamHandled = (forceEndPosition: number) => {
        this._slowStreamHandled = true;
        this._forceEndPosition = forceEndPosition;

    }


    public get currentPosition() {
        return this._currentPosition;
    }

    public get isSlowStream() {
        if (this.hasHealthyBuffer) return false;
        if (this.isGoodStream) return false;
        log.info(`slow stream debug: ${this.hasHealthyBuffer}, ${this.isGoodStream}`);
        return true;
    }

    private get hasHealthyBuffer() {
        if (this._bufferSnapshot.length < BufferSnapshotMaxItems) return true;
        const avgBufferSize = this._bufferSnapshot.reduce((acc, c) => acc + c.readAheadBufferSize, 0) / this._bufferSnapshot.length;
        return avgBufferSize > 1 * 1000 * 1000; //1MB buffer avg then it's a good stream
    }

    private get isGoodStream() {
        if (this._speedSnapshot.length < BufferSnapshotMaxItems) return true;

        const start = this._speedSnapshot.at(0)
        const end = this._speedSnapshot.at(-1)

        if (start && end) {
            const totalSecondsElapsed = dayjs(end.ts).diff(start.ts, 'seconds');
            //const totalSecondsElapsed = (end.ts - start.ts)/1000;
            const totalBytesDownloaded = end.bytesDownloaded - start.bytesDownloaded;
            const avgSpeed = totalBytesDownloaded / totalSecondsElapsed;
            if (avgSpeed > 1 * 1000 * 1000) return true;
        }
        return false;
    }


    public get stats() {
        const { lastUsed, startPosition, _lastReaderPosition, _drainRequested, _currentPosition: currentPosition, _readAheadExceeded, _bufferSnapshot, isGoodStream, hasHealthyBuffer, _slowStreamHandled } = this;
        return {
            startPosition,
            lastUsed,
            currentPosition,
            lastReaderPosition: _lastReaderPosition,
            drainRequested: _drainRequested,
            readAheadExceeded: _readAheadExceeded,
            readAheadBufferSnapshot: _bufferSnapshot,
            isGoodStream, hasHealthyBuffer,
            slowStreamHandled: _slowStreamHandled
        };
    }
}