interface ChunkRecord {
    timestamp: number;
    bytes: number;
}

export class StreamSpeedTester {
    private chunks: ChunkRecord[] = [];
    private cumulativeBytes = 0;

    private activeStartTime: number | null = null; // when current active period started
    private activeMs = 0; // total active streaming time

    /** Call this when stream starts or resumes */
    startActivePeriod() {
        if (!this.activeStartTime) {
            this.activeStartTime = Date.now();
        }
    }

    /** Call this when stream is paused */
    pauseActivePeriod() {
        if (this.activeStartTime) {
            // add this active stretch to total active time
            this.activeMs += Date.now() - this.activeStartTime;
            this.activeStartTime = null;
        }
    }

    /** Add bytes received during streaming */
    addData(bytes: number) {
        const now = Date.now();
        this.chunks.push({ timestamp: now, bytes });
        this.cumulativeBytes += bytes;

        // keep only last 5s of chunks for sliding window
        const cutoff = now - 5000;
        this.chunks = this.chunks.filter(c => c.timestamp >= cutoff);
    }

    /** Current speed = bytes per second over the last 5s */
    get currentSpeedBps(): number {
        if (this.chunks.length === 0) return 0;

        const now = Date.now();
        const cutoff = now - 5000;
        const windowBytes = this.chunks
            .filter(c => c.timestamp >= cutoff)
            .reduce((sum, c) => sum + c.bytes, 0);

        return windowBytes / 5;
    }

    /** Cumulative speed = avg bytes/sec over total *active* time */
    get cumulativeSpeedBps(): number {
        let totalActiveMs = this.activeMs;

        // if currently active, include ongoing active duration
        if (this.activeStartTime) {
            totalActiveMs += Date.now() - this.activeStartTime;
        }

        if (totalActiveMs <= 0) return 0;

        return this.cumulativeBytes / (totalActiveMs / 1000);
    }

    clear() {
        this.chunks = [];
        this.cumulativeBytes = 0;
        this.activeStartTime = null;
        this.activeMs = 0;
    }

    /** Debug helper */
    logSpeed() {
        console.log(
            `cumulativeSpeedBps: ${this.cumulativeSpeedBps.toFixed(2)}, currentSpeedBps: ${this.currentSpeedBps.toFixed(2)}`
        );
    }
}
