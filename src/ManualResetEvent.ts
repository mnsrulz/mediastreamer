import { EventEmitter } from 'node:events';
import { pEvent } from 'p-event';

export class ManualResetEvent {
    private _bus = new EventEmitter();
    private _signaled;
    public static createNew = (state = false) => new ManualResetEvent(state);
    constructor(initialState = false) {
        this._signaled = initialState;
    }
    public wait = async (timeout?: number) => {
        if (!this._signaled) {
            await pEvent(this._bus, 'raised', {
                timeout: timeout
            });
        }
    };

    public set() {
        if (this._signaled)
            return;
        this._signaled = true;
        this._bus.emit('raised');
    }

    public reset() {
        this._signaled = false;
    }
}
