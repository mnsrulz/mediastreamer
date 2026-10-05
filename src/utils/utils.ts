import { setTimeout } from 'node:timers/promises';
export const parseRangeRequest = (size: number, rangeHeader: string | string[] | undefined) => {
    let range: string = '';
    if (rangeHeader) {
        if (Array.isArray(rangeHeader))
            range = rangeHeader[0];
        else
            range = rangeHeader;
    }
    if (range?.startsWith('bytes=')) {
        const kis = range.substring(6).split('-');
        if (kis[0] == '') {
            const lastBytes = Number.parseInt(kis[1]);
            return {
                start: size - lastBytes,
                end: size - 1
            }
        } else {
            const parsedEnd = Number.parseInt(kis[1]);
            return {
                start: Number.parseInt(kis[0]),
                end: Number.isFinite(parsedEnd) ? Math.min(parsedEnd, size - 1) : size - 1
            }
        }
        //do for the no start/end ranges
    }
}

export const delay = setTimeout;

export type EntryRangeResult =
    | {
        ok: true,
        start: number,
        end: number,
        relStart: number,
        relEnd: number,
        absStart: number,
        absEnd: number,
        entryLen: number,
        partial: boolean
    }
    | { ok: false, status: 400 | 416, error: string };

export const resolveEntryRange = (
    fileSegment: string,
    rangeHeader: string | string[] | undefined,
    zipSize: number
): EntryRangeResult => {
    const match = /^f(\d+)-(\d+)$/.exec(fileSegment ?? '');
    if (!match) {
        return { ok: false, status: 400, error: `Invalid entry segment '${fileSegment}', expected f{start}-{end}` };
    }

    const start = Number(match[1]);
    const end = Number(match[2]);

    if (start > end) {
        return { ok: false, status: 400, error: `Invalid entry window ${start}-${end}, start is greater than end` };
    }
    if (start >= zipSize || end >= zipSize) {
        return { ok: false, status: 416, error: `Entry window ${start}-${end} is outside the archive of ${zipSize} bytes` };
    }

    const entryLen = end - start + 1;
    const range = (rangeHeader && parseRangeRequest(entryLen, rangeHeader)) || { start: 0, end: entryLen - 1 };
    const relStart = Math.max(range.start, 0);
    const relEnd = Math.min(Math.max(range.end, 0), entryLen - 1);

    return {
        ok: true,
        start,
        end,
        relStart,
        relEnd,
        absStart: start + relStart,
        absEnd: start + relEnd,
        entryLen,
        partial: Boolean(rangeHeader)
    };
};


export const parseContentLengthFromRangeHeader = (headerValue: string | null): number | undefined => {
    if (headerValue) {
        return parseInt(headerValue.split('/').pop() || '0');
    }
}

export const parseByteRangeFromResponseRangeHeader = (headerValue: string | null): { start: number, end: number, length: number } | undefined => {
    if (headerValue) {
        const match = headerValue.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/);
        if (match) {
            return {
                start: Number(match[1]),
                end: Number(match[2]),
                length: Number(match[3])
            }
        }
    }
}

