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

export const streamerv2 = async (streamUrlModel: StreamUrlModel, bf: VirtualBufferCollection, size: number, initialPosition: number)=> {
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
    public currentPosition = 0;
    private _lastReaderPosition = 0;
    public lastUsed = new Date();
    private _drainRequested = false;
    private _gotStream: Request;
    private _readAheadExceeded = false;
    private _mre = ManualResetEvent.createNew();
    private _bf: VirtualBufferCollection;
    private _intervalPointer: NodeJS.Timer;
    //bus = new EventEmitter();
    _streamUrlModel: StreamUrlModel;

    constructor(stream: Request, initialPosition: number, bf: VirtualBufferCollection, um: StreamUrlModel) {
        this.startPosition = initialPosition;
        this.currentPosition = initialPosition;
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
    }
    
    public startStreaming = async () => {
        try {
            log.info(`yay! we found a good stream... traversing it..`);
            for await (const chunk of this._gotStream) {
                if(this._drainRequested) break;

                const _buf = (chunk as Buffer);                
                this._bf.push(_buf, this.currentPosition);      //_self.emit('data', { buffer: _buf, position: _self.currentPosition });
                this.currentPosition += _buf.byteLength;
                this.lastUsed = new Date();

                if(this._bf.existingBufferWhichCanSatisfyPosition(this.currentPosition)) {
                    log.info(`there's already a buffer which can satisfy upcomping buffer position '${this.currentPosition}' so breaking this stream.`);
                    break;
                }

                while (!this._drainRequested && this.currentPosition > this._lastReaderPosition + (config.readAheadSizeMB * 1024 * 1024)) { //advance bytes
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
        }
    };

    public CanResolve = (position: number) => position >= this.startPosition && position <= this.currentPosition;

    public resume = () => {
        this.lastUsed = new Date();
        this._lastReaderPosition = this.currentPosition;
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