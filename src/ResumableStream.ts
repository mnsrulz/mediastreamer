import prettyBytes from 'pretty-bytes';
import got, { Request, Response } from 'got';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime.js';
dayjs.extend(relativeTime)
import { ManualResetEvent } from './utils/ManualResetEvent.js';
import { log } from './app.js';
import { parseByteRangeFromResponseRangeHeader, parseContentLengthFromRangeHeader } from './utils/utils.js';
import config from './config.js';
import { StreamSource } from './models/StreamUrlModel.js';
import { VirtualBufferCollection } from './models/VirtualBufferCollection.js';
import { StreamSpeedTester } from './utils/streamSpeedTester.js';
const BufferSnapshotMaxItems = 10;  //buffer snapshot max items for finding the stream health

export const createResumableStream = async (streamUrlModel: StreamSource, bf: VirtualBufferCollection, size: number, initialPosition: number) => {
    log.info(`Building a new '${new URL(streamUrlModel.streamUrl).host}' stream with rank ${streamUrlModel.speedRank} offset: ${initialPosition}`);

    const _internalHeaders = streamUrlModel.headers || {};
    _internalHeaders['Range'] = `bytes=${initialPosition}-`;

    return new Promise<ResumableStream>((res, rej) => {
        const _gotStream = got.stream(streamUrlModel.streamUrl, {
            https: { rejectUnauthorized: false },
            headers: _internalHeaders
        }).on('response', (response: Response) => {
            log.info(`Response received from the stream '${new URL(streamUrlModel.streamUrl).host}' source. StatusCode: ${response.statusCode}`);
            const contentLengthHeader = parseInt(response.headers['content-length'] || '0');
            const potentialContentLength = parseContentLengthFromRangeHeader(response.headers['content-range'] || '')
                || contentLengthHeader;

            if (initialPosition > 0) {  //ensure the stream response respected the start position
                const rangeValues = parseByteRangeFromResponseRangeHeader(response.headers['content-range'] || '');
                if (rangeValues?.start != initialPosition)
                    rej(new Error(`Range Mismatch : Initial position ${initialPosition} is not in the range of the response.`));
            }

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
    private _streamId = crypto.randomUUID();
    public startPosition = 0;
    private _currentPosition = 0;
    private _lastReaderPosition = 0;
    private _lastUsed = new Date();
    private _drainRequested = false;
    private _gotStream: Request;
    private _readAheadExceeded = false;
    private _lastReadAheadExceededTime: Date | undefined;
    private _mre: ManualResetEvent;
    private _firstChunkMre: ManualResetEvent;
    private _bf: VirtualBufferCollection;
    private _intervalPointer: NodeJS.Timeout;
    private _bufferSnapshotIntervalPointer: NodeJS.Timeout;
    private _bufferSnapshot: { ts: Date, readAheadBufferSize: number }[] = []
    private _speedSnapshot: { ts: Date, bytesDownloaded: number }[] = []
    private _slowStreamHandled = false;   //use this in conjuction with speed_bps and buffer health
    private _bytesDownloaded = 0;
    private _forceEndPosition = Number.MAX_VALUE;
    private _speedTester = new StreamSpeedTester();
    //bus = new EventEmitter();
    _streamUrlModel: StreamSource;
    private _streamHost: string;


    constructor(stream: Request, initialPosition: number, bf: VirtualBufferCollection, um: StreamSource) {
        this.startPosition = initialPosition;
        this._currentPosition = initialPosition;
        this._lastReaderPosition = initialPosition;
        this._gotStream = stream;
        this._bf = bf;
        this._streamUrlModel = um;
        this._streamHost = new URL(um.streamUrl).hostname;
        this._mre = ManualResetEvent.createNew();
        this._firstChunkMre = ManualResetEvent.createNew();
        //this is to show if the stream break the code behaves appropriately.
        //move this to global monitoring.. these sort of actions can be decoupled
        this._intervalPointer = setInterval(() => {
            if (dayjs(this._lastUsed).isBefore(dayjs(new Date()).subtract(10, 'minute'))) {
                log.warn(`Forcing the stream to auto destroy after idling for more than 10 minute`);
                this.drainIt();
            }
        }, 20000);

        this._bufferSnapshotIntervalPointer = setInterval(this.performBufferSnapshot, 1000);
    }

    private performBufferSnapshot = () => {
        const { _bufferSnapshot, _speedSnapshot, _currentPosition, _lastReaderPosition, _bytesDownloaded } = this;
        const ts = new Date()
        _bufferSnapshot.push({ ts, readAheadBufferSize: _currentPosition - _lastReaderPosition });
        _speedSnapshot.push({ ts, bytesDownloaded: _bytesDownloaded })

        if (_bufferSnapshot.length > BufferSnapshotMaxItems) {
            _bufferSnapshot.shift();
        }

        if (_speedSnapshot.length > BufferSnapshotMaxItems) {
            _speedSnapshot.shift();
        }
    }

    /**wait for the first chunk to be available*/
    public async waitForFirstChunk(timeout: number) {
        await this._firstChunkMre.wait(timeout, true);
    }

    public startStreaming = async () => {
        try {
            let firstChunkReceived = false;
            log.info(`Yay! We found a good stream... traversing it..`);

            this._speedTester.startActivePeriod();

            for await (const chunk of this._gotStream) {
                if (!firstChunkReceived) {
                    this._firstChunkMre.set();  //this signals that the first chunk has been received. Might be good if there's a way to do it only once. For now we are good.
                    firstChunkReceived = true;
                }

                if (this._drainRequested) break;

                const _buf = (chunk as Buffer);
                this._bf.push(_buf, this._currentPosition);      //_self.emit('data', { buffer: _buf, position: _self.currentPosition });
                this._currentPosition += _buf.byteLength; this._bytesDownloaded += _buf.byteLength;

                this._speedTester.addData(_buf.byteLength);

                this._lastUsed = new Date();

                if (this._bf.existingBufferWhichCanSatisfyPosition(this._currentPosition)) {
                    log.info(`There's already a buffer which can satisfy upcomping buffer position '${this._currentPosition}' so breaking this stream.`);
                    break;
                }

                if (this._currentPosition >= this._forceEndPosition) {
                    log.info(`Force end position (${this._forceEndPosition}) detected for this stream at buffer position '${this._currentPosition}' so breaking this stream.`);
                    break;
                }

                while (!this._drainRequested && this._currentPosition > this._lastReaderPosition + (config.readAheadSizeMB * 1024 * 1024)) { //advance bytes
                    this._readAheadExceeded = true;
                    this._lastReadAheadExceededTime = new Date();
                    //await pEvent(this.bus, 'unlocked');    //do we need a bus?
                    log.info(`Stream read ahead exhausted. Pausing for a while`);
                    this._mre.reset();
                    this._speedTester.pauseActivePeriod();
                    await this._mre.wait();
                    log.info(`Resuming the stream`);
                    this._readAheadExceeded = false;
                    this._lastReadAheadExceededTime = undefined;
                    this._speedTester.startActivePeriod();
                }
            }
        } catch (error) {
            if (this._drainRequested) {
                log.info(`Stream ended as drain requested. Actual Err: ${(error as Error)?.message}`);
            } else {
                log.error(`Error occurred while iterating the stream. Actual Err: ${(error as Error)?.message}`);
            }
        } finally {
            clearInterval(this._intervalPointer);
            clearInterval(this._bufferSnapshotIntervalPointer);
        }
    };

    public CanResolve = (position: number) => position === this._currentPosition + 1;

    public resume = () => {
        this._lastUsed = new Date();
        this._lastReaderPosition = this._currentPosition;
        //this.bus.emit('unlocked');
        this._mre.set();
    };


    /**this is helpful to advance the position of the stream if it's in read exhaust mode*/
    public markLastReaderPosition = (position: number) => {
        if (this._lastReaderPosition < position) {
            this._lastReaderPosition = position;
            //this.bus.emit('unlocked');
            this._mre.set();
        }
    };

    public drainIt = () => {
        log.info(`Drain requested so destroying the existing stream...`);
        this._drainRequested = true;
        this._gotStream.destroy();
        //this.bus.emit('unlocked');
        this._mre.set();
    };


    public get slowStreamHandled() {
        return this._slowStreamHandled
    }

    public get streamId() {
        return this._streamId;
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
        log.info(`Slow stream debug. HasHealthyBuffer/IsGoodStream ${this.hasHealthyBuffer}/${this.isGoodStream}`);
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
        const { streamId, _lastUsed, startPosition, _lastReaderPosition, _drainRequested, _currentPosition: currentPosition, _readAheadExceeded, _bufferSnapshot, isGoodStream, hasHealthyBuffer, _speedTester,
            _slowStreamHandled, _lastReadAheadExceededTime, _streamHost } = this;
        return {
            streamId,
            startPosition,
            startPositionHuman: prettyBytes(startPosition),
            lastUsed: _lastUsed,
            lastUsedAgo: dayjs(_lastUsed).fromNow(),
            currentPosition,
            currentPositionHuman: prettyBytes(currentPosition),
            lastReaderPosition: _lastReaderPosition,
            lastReaderPositionHuman: prettyBytes(_lastReaderPosition),
            drainRequested: _drainRequested,
            readAheadExceeded: _readAheadExceeded,
            lastReadAheadExceededTime: _lastReadAheadExceededTime,
            readAheadBufferSnapshot: _bufferSnapshot,
            isGoodStream, hasHealthyBuffer,
            slowStreamHandled: _slowStreamHandled,
            speedStats: {
                cumulativeSpeedBps: _speedTester.cumulativeSpeedBps,
                currentSpeedBps: _speedTester.currentSpeedBps,
                cumulativeSpeedHuman: prettyBytes(_speedTester.cumulativeSpeedBps),
                currentSpeedHuman: prettyBytes(_speedTester.currentSpeedBps)
            },
            sourceHost: _streamHost
        };
    }
}

export class ResumableStreamCollection {
    private readonly _streams: ResumableStream[] = [];
    /**try resuming the stream from the position if any of the existing streams can fullfill the range*/
    public tryResumingStreamFromPosition(position: number) {
        const exisitngStreams = this._streams.filter(x => x.CanResolve(position));
        if (exisitngStreams.length > 0) {
            //log.info(`existing stream found which can satisfy it. args: ${JSON.stringify(args)}`);
            if (exisitngStreams.length > 1) {
                log.warn(`Multiple streams found which can satisfy position:${position}. Going with the first one.`);
            }
            exisitngStreams[0].resume();
            return true;
        }
        return false;
    }

    public get length(): number {
        return this._streams.length;
    }

    public addStream(stream: ResumableStream) {
        this._streams.push(stream);
    }

    public removeStream(stream: ResumableStream) {
        log.info(`Removing the gostream: ${new URL(stream._streamUrlModel.streamUrl).hostname}`)
        const index = this._streams.indexOf(stream); // find element index
        if (index > -1) {
            this._streams.splice(index, 1); // removes 1 element at that index
        }
    }

    public updateSpeedRanks(docIdSpeedRankMap: Map<string, number>) {
        this._streams.forEach(x => {
            x._streamUrlModel.speedRank = docIdSpeedRankMap.get(x._streamUrlModel.docId) || x._streamUrlModel.speedRank;
        })
    }

    public get Items() {
        return [...this._streams];
    }

    public dispose() {
        for (const stream of this._streams) {
            stream.drainIt();
        }
    }
}