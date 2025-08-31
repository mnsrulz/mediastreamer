import { sort } from "fast-sort";

export interface StreamSource { streamUrl: string; headers: Record<string, string>; speedRank: number; docId: string; status: 'HEALTHY' | 'UNHEALTHY'; }

export class StreamSourceCollection {
    public get items() {
        return this._items.map(({ headers, ...rest }) => ({ ...rest }));
    }

    remove(stream: StreamSource) {
        this._items = this._items.filter(x => x !== stream);
    }
    private _items: StreamSource[] = [];
    constructor(items: StreamSource[]) {
        this._items = items || [];
    }
    merge(streams: StreamSource[]) {
        const docIds = streams.map(x => x.docId);
        this._items = [...streams, ...this._items.filter(x => !docIds.includes(x.docId))];
    }
    fastest() {
        return sort(this._items).desc(x => x.speedRank)[0];
    }

    fastestButNot(stream: StreamSource) {
        return sort(this._items.filter(x => x !== stream)).desc(x => x.speedRank)[0];
    }

    isEmpty() {
        return this._items.length === 0;
    }
}
