import prettyBytes from 'pretty-bytes';
import { log } from '../app.js';

export class StreamSpeedTester {
    //private _lastTimer: Date;
    private _ct = 0;
    private tmr: NodeJS.Timer;
    private _speed_bps =0;
    public get speed_bps()  {
        return this._speed_bps;
    }
    
    constructor() {
        this.tmr = setInterval(() => {
            this._speed_bps = this._ct / 5
            log.info(`stream speed: ${prettyBytes(this._speed_bps)}/sec`);
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
