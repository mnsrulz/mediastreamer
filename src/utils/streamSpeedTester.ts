import prettyBytes from 'pretty-bytes';
import { log } from '../app.js';

export class StreamSpeedTester {
    //private _lastTimer: Date;
    private _ct = 0;
    private tmr: NodeJS.Timer;
    constructor() {
        this.tmr = setInterval(() => {
            log.info(`stream speed: ${prettyBytes(this._ct / 5)}/sec`);
            this._ct = 0;
        }, 5000);
    }

    addData = (d: number) => {
        this._ct += d;
    };

    Clear = () => {
        clearInterval(this.tmr);
    };
}
