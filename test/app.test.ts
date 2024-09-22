import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { VirtualBufferCollection } from '../src/models/VirtualBufferCollection.js';
import { parseRangeRequest, parseContentLengthFromRangeHeader, parseByteRangeFromResponseRangeHeader } from '../src/utils/utils.js';

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