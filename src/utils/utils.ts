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
        } else
            return {
                start: Number.parseInt(kis[0]),
                end: Math.min(Number.parseInt(kis[1]), size - 1) || (size - 1)
            }
        //do for the no start/end ranges
    }
}

export const delay = setTimeout;

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

