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
        return {
            start: Number.parseInt(kis[0]),
            end: Number.parseInt(kis[1]) || size
        }
        //do for the no start/end ranges
    }
}
