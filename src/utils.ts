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
