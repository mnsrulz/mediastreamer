import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { VirtualBufferCollection } from '../src/models/VirtualBufferCollection.js';
import { parseRangeRequest, parseContentLengthFromRangeHeader, parseByteRangeFromResponseRangeHeader, resolveEntryRange } from '../src/utils/utils.js';
import { buildLinksQuery, filterLinkSources } from '../src/apiClient.js';

describe('Buffer collection tests', () => {
    it('buffer collection consolidate buffers test', () => {
        const bc = new VirtualBufferCollection();
        bc.push(Buffer.from('abc'), 0);
        bc.push(Buffer.from('def'), 3);
        bc.push(Buffer.from('vw'), 21);
        bc.push(Buffer.from('wxy'), 23);
        bc.push(Buffer.from('xyz'), 24);
        assert.equal(bc.bufferArrayCount, 3);
    })

    it('buffer collection consolidate buffers test negative position', () => {
        const bc = new VirtualBufferCollection();
        assert.throws(() => bc.push(Buffer.from('56789'), -1))
    })

    it('buffer collection consolidate buffers overlapping test', () => {
        const bc = new VirtualBufferCollection();
        bc.push(Buffer.from('01234'), 0)
        assert.ok(!bc.existingBufferWhichCanSatisfyPosition(5))
        bc.push(Buffer.from('56789'), 5)
        assert.ok(bc.existingBufferWhichCanSatisfyPosition(5))
    })
})

describe('Range header tests', () => {

    it('parseRange header tests', () => {
        const rangeRequest = parseRangeRequest(1000, 'bytes=0-10');
        assert.equal(rangeRequest?.start, 0);
        assert.equal(rangeRequest?.end, 10);
    });

    it('parseRange header final bytes tests', () => {
        const rangeRequest = parseRangeRequest(1000, 'bytes=-10');
        assert.equal(rangeRequest?.start, 990);
        assert.equal(rangeRequest?.end, 999);
    });

    it('parseRange header from bytes tests', () => {
        const rangeRequest = parseRangeRequest(1000, 'bytes=900-');
        assert.equal(rangeRequest?.start, 900);
        assert.equal(rangeRequest?.end, 999);
    });

    it('parseRange header from bytes tests with end range exceeding', () => {
        const rangeRequest = parseRangeRequest(1000, 'bytes=900-1050');
        assert.equal(rangeRequest?.start, 900);
        assert.equal(rangeRequest?.end, 999);
    });

    it('parseRange header single byte at start test', () => {
        const rangeRequest = parseRangeRequest(1000, 'bytes=0-0');
        assert.equal(rangeRequest?.start, 0);
        assert.equal(rangeRequest?.end, 0);
    });

    it('parseContentLengthFromRangeHeader header test', () => {
        const contentLen = parseContentLengthFromRangeHeader('bytes 1-10/11501179163');
        assert.equal(contentLen, 11501179163);
    })

    it('parseByteRangeFromResponseRangeHeader header test', () => {
        const range = parseByteRangeFromResponseRangeHeader('bytes 1-10/11501179163');
        assert.equal(range?.start, 1);
        assert.equal(range?.end, 10);
        assert.equal(range?.length, 11501179163);
    })
})

describe('resolveEntryRange tests', () => {

    it('range inside the entry', () => {
        const result = resolveEntryRange('f1000-1999', 'bytes=100-199', 100000);
        assert.ok(result.ok);
        assert.equal(result.start, 1000);
        assert.equal(result.end, 1999);
        assert.equal(result.relStart, 100);
        assert.equal(result.relEnd, 199);
        assert.equal(result.absStart, 1100);
        assert.equal(result.absEnd, 1199);
        assert.equal(result.entryLen, 1000);
        assert.equal(result.partial, true);
    });

    it('open-ended range', () => {
        const result = resolveEntryRange('f1000-1999', 'bytes=500-', 100000);
        assert.ok(result.ok);
        assert.equal(result.relStart, 500);
        assert.equal(result.relEnd, 999);
        assert.equal(result.absStart, 1500);
        assert.equal(result.absEnd, 1999);
    });

    it('suffix range', () => {
        const result = resolveEntryRange('f1000-1999', 'bytes=-100', 100000);
        assert.ok(result.ok);
        assert.equal(result.relStart, 900);
        assert.equal(result.relEnd, 999);
        assert.equal(result.absStart, 1900);
        assert.equal(result.absEnd, 1999);
    });

    it('range end beyond the entry is clamped', () => {
        const result = resolveEntryRange('f1000-1999', 'bytes=900-5000', 100000);
        assert.ok(result.ok);
        assert.equal(result.relStart, 900);
        assert.equal(result.relEnd, 999);
        assert.equal(result.absEnd, 1999);
    });

    it('no range returns the whole entry', () => {
        const result = resolveEntryRange('f1000-1999', undefined, 100000);
        assert.ok(result.ok);
        assert.equal(result.relStart, 0);
        assert.equal(result.relEnd, 999);
        assert.equal(result.absStart, 1000);
        assert.equal(result.absEnd, 1999);
        assert.equal(result.entryLen, 1000);
        assert.equal(result.partial, false);
    });

    it('bytes=0-0 returns a single byte', () => {
        const result = resolveEntryRange('f1000-1999', 'bytes=0-0', 100000);
        assert.ok(result.ok);
        assert.equal(result.relStart, 0);
        assert.equal(result.relEnd, 0);
        assert.equal(result.absStart, 1000);
        assert.equal(result.absEnd, 1000);
        assert.equal(result.relEnd - result.relStart + 1, 1);
    });

    it('window end beyond the archive returns 416', () => {
        const result = resolveEntryRange('f0-1500', undefined, 1000);
        assert.ok(!result.ok);
        assert.equal(result.status, 416);
    });

    it('window start beyond the archive returns 416', () => {
        const result = resolveEntryRange('f5000-6000', undefined, 1000);
        assert.ok(!result.ok);
        assert.equal(result.status, 416);
    });

    it('inverted window returns 400', () => {
        const result = resolveEntryRange('f5000-1000', undefined, 100000);
        assert.ok(!result.ok);
        assert.equal(result.status, 400);
    });

    it('malformed window segment returns 400', () => {
        for (const segment of ['fabc', 'f1000-', 'f-1000', 'x1000-2000', '1000-2000', '']) {
            const result = resolveEntryRange(segment, undefined, 100000);
            assert.ok(!result.ok, `expected failure for '${segment}'`);
            assert.equal(result.status, 400, `expected 400 for '${segment}'`);
        }
    });
})
describe('Link query tests', () => {

    it('archive-sized link query disables expansion', () => {
        const query = buildLinksQuery('tt123', 4294967296);
        assert.equal(query['imdbId'], 'tt123');
        assert.equal(query['size'], 4294967296);
        assert.equal(query['per_page'], 100);
        assert.equal(query['expand'], false);
    });

    it('link query without size omits size', () => {
        const query = buildLinksQuery('tt123');
        assert.equal(query['expand'], false);
        assert.ok(!('size' in query));
    });

    it('derived and non-valid items are filtered out', () => {
        const items = [
            { id: '1', status: 'Valid', isDerived: false },
            { id: '2', status: 'Valid', isDerived: true },
            { id: '3', status: 'Valid' },
            { id: '4', status: 'Invalid', isDerived: false }
        ];
        const filtered = filterLinkSources(items);
        assert.deepEqual(filtered.map(x => x.id), ['1', '3']);
    });
})
