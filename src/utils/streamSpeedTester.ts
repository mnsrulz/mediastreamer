import prettyBytes from 'pretty-bytes';
import { log } from '../app.js';

interface ChunkRecord {
    timestamp: number;
    bytes: number;
}

export class StreamSpeedTester {
    private chunks: ChunkRecord[] = [];
    private cumulativeBytes = 0;
    // private intervalPointer: NodeJS.Timer | null = null;
    // private intervalMs: number;
    private activeStartTime: number | null = null; // tracks streaming periods
    private pausedTime = 0;

    constructor(logIntervalMs = 5000) {
        // this.intervalMs = logIntervalMs;
        // this.intervalPointer = setInterval(() => this.logSpeed(), this.intervalMs);
    }

    /** Call this when stream starts or resumes */
    startActivePeriod() {
        if (!this.activeStartTime) {
            this.activeStartTime = Date.now();
        }
    }

    /** Call this when stream is paused */
    pauseActivePeriod() {
        if (this.activeStartTime) {
            this.pausedTime += Date.now() - this.activeStartTime;
            this.activeStartTime = null;
        }
    }

    addData(bytes: number) {
        const now = Date.now();
        this.chunks.push({ timestamp: now, bytes });
        this.cumulativeBytes += bytes;

        // remove old chunks for sliding window
        const cutoff = now - 5000; 
        this.chunks = this.chunks.filter(c => c.timestamp >= cutoff);
    }

    get currentSpeedBps(): number {
        if (this.chunks.length === 0) return 0;

        const now = Date.now();
        const cutoff = now - 5000;
        const windowBytes = this.chunks.filter(c => c.timestamp >= cutoff)
                                       .reduce((sum, c) => sum + c.bytes, 0);
        const elapsedSec = 5; // sliding window duration
        return windowBytes / elapsedSec;
    }

    /** Cumulative speed only counting active periods */
    get cumulativeSpeedBps(): number {
        const now = Date.now();
        const startTime = this.chunks[0]?.timestamp || now;
        const elapsedMs = Math.max(now - startTime - this.pausedTime, 1);
        return this.cumulativeBytes / (elapsedMs / 1000);
    }

    private logSpeed() {
        const speed = this.currentSpeedBps;
        log.info(`Stream speed: ${prettyBytes(speed)}/s`);
    }

    clear() {
        // if (this.intervalPointer) clearInterval(this.intervalPointer);
        this.chunks = [];
        this.cumulativeBytes = 0;
        this.activeStartTime = null;
        this.pausedTime = 0;
    }
}