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
type ResumableStreamDataEventArgs = { position: number, buffer: Buffer }
type ResumableStreamEventTypes = { 'data': [args: ResumableStreamDataEventArgs], 'error': [arg1: Error] }
/*
Stream responsible for building a new stream and emitting the data in an effective manner
*/
export class ResumableStream extends TypedEventEmitter<ResumableStreamEventTypes> {
    public startPosition = 0;
    public currentPosition = 0;
    private _lastReaderPosition = 0;
    public lastUsed = new Date();
    private _drainRequested = false;
    private _gotStream: Request;
    private _readAheadExceeded = false;
    _mre = ManualResetEvent.createNew();
    intervalPointer: NodeJS.Timer;
    bus = new EventEmitter();
    isSuccessful = false;
    _streamUrlModel: StreamUrlModel;

    constructor(streamUrlModel: StreamUrlModel, size: number, initialPosition: number) {
        super();
        const _i = this;
        this._streamUrlModel = streamUrlModel;
        log.info(`Building a new '${new URL(streamUrlModel.streamUrl).host}' stream with rank ${streamUrlModel.speedRank} offset: ${initialPosition}`);

        _i.startPosition = initialPosition;
        _i.currentPosition = initialPosition;
        _i._lastReaderPosition = initialPosition;

        const _internalHeaders = streamUrlModel.headers || {};
        _internalHeaders['Range'] = `bytes=${initialPosition}-`;

        this._gotStream = got.stream(streamUrlModel.streamUrl, {
            https: { rejectUnauthorized: false },
            headers: _internalHeaders,
            throwHttpErrors: false
        }).on('response', (response: Response) => {
            if (response.statusCode >= 200 && response.statusCode < 300) {
                const contentLengthHeader = parseInt(response.headers['content-length'] || '0');
                const potentialContentLength = parseContentLengthFromRangeHeader(response.headers['content-range'] || '')
                    || contentLengthHeader;

                if (size !== potentialContentLength) {
                    log.info(`content length mismatch: E/A ${size}/${potentialContentLength}`);
                } else {
                    log.info(`successful stream acquired with matching content length ${potentialContentLength}`);
                    _i.isSuccessful = true;
                }
            } else {
                log.warn(`non successfull response code received: ${response.statusCode}`);
            }
            if (!_i.isSuccessful) {
                _i.emit('error', new Error('non successfull response received'));
            }
            _i._mre.set();
        }).on('error', (err) => {
            log.error(`error occurred during the gotstream: ${err.message}`);
            _i._mre.set();
            _i.emit('error', err );
        });

        //this is to show if the stream break the code behaves appropriately.
        //move this to global monitoring.. these sort of actions can be decoupled
        this.intervalPointer = setInterval(() => {
            if (dayjs(_i.lastUsed).isBefore(dayjs(new Date()).subtract(10, 'minute'))) {
                log.warn(`ok.. forcing the stream to auto destroy after idling for more than 10 minute`);
                _i.drainIt();
            }
        }, 20000);
    }

    public startStreaming = async () => {
        const _self = this;
        try {
            await _self._mre.wait();
            if (!_self.isSuccessful) throw new Error(`non successfull stream response recvd...`);
            log.info(`yay! we found a good stream... traversing it..`);
            for await (const chunk of _self._gotStream) {
                const _buf = (chunk as Buffer);
                _self.emit('data', { buffer: _buf, position: _self.currentPosition });
                //_self._internalstream._bufferArray.push(_buf, _self.currentPosition);
                _self.currentPosition += _buf.byteLength;
                _self.lastUsed = new Date();
                while (!_self._drainRequested && _self.currentPosition > _self._lastReaderPosition + (config.readAheadSizeMB * 1024 * 1024)) { //advance bytes
                    _self._readAheadExceeded = true;
                    await pEvent(_self.bus, 'unlocked');
                }
                _self._readAheadExceeded = false;
            }
        } catch (error) {
            _self._drainRequested ?
                log.info(`stream ended as drain requested`) :
                log.error(`error occurred while iterating the stream...`); //in case of errors the system will just create a new stream automatically.
        } finally {
            clearInterval(_self.intervalPointer);
        }
    };

    public CanResolve = (position: number) => position >= this.startPosition && position <= this.currentPosition;

    public resume = () => {
        this.lastUsed = new Date();
        this._lastReaderPosition = this.currentPosition;
        this.bus.emit('unlocked');
    };

    //maybe a better name needed but this is helpful to advance the position of the stream if it's in read exhaust mode
    public markLastReaderPosition = (position: number) => {
        if (this._lastReaderPosition < position) {
            this._lastReaderPosition = position;
            this.bus.emit('unlocked');
        }
    };

    public drainIt = () => {
        log.info(`drain requested so destryoing the existing stream...`);
        this._drainRequested = true;
        this._gotStream.destroy();
        this.bus.emit('unlocked');
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
