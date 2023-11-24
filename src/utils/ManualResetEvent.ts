import { EventEmitter } from 'node:events';
import { pEvent } from 'p-event';

export class ManualResetEvent {
    private _bus = new EventEmitter();
    private _signaled;
    public static createNew = (state = false) => new ManualResetEvent(state);
    constructor(initialState = false) {
        this._signaled = initialState;
    }
    ///Wait for the signal. Make sure to call the reset before this method.
    public wait = async (timeout?: number, throwOnTimeout?: boolean) => {
        if (!this._signaled) {
            try {
                await pEvent(this._bus, 'raised', {
                    timeout: timeout
                });
            } catch (error) {
                if (throwOnTimeout) {
                    if (error as Error) {
                        throw error;
                    } else {
                        throw new Error('timeout error!');
                    }
                }
            }
        }
    };

    ///Signal the awaiter to proceed
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
