import test from 'ava';
import { MyBufferCollection } from './MyBufferCollection.js';
import { MyBuffer } from "./MyBuffer.js";
import { parseRangeRequest } from './utils.js';


test('buffer collection consolidate buffers test', t => {
    const bc = new MyBufferCollection();
    bc.push(new MyBuffer(Buffer.from('abc'), 0, 2));
    bc.push(new MyBuffer(Buffer.from('def'), 3, 5));
    bc.push(new MyBuffer(Buffer.from('vw'), 21, 22));
    bc.push(new MyBuffer(Buffer.from('xyz'), 23, 25));
    bc.push(new MyBuffer(Buffer.from('xyz'), 24, 300));

    console.log('erroring...')
    bc.consolidateBuffers();

    console.log(bc.bufferArrayCount);
    t.is(bc.bufferArrayCount, 3);
});

test('parseRange header tests', t => {
    const rangeRequest = parseRangeRequest(1000, 'bytes=0-10');
    t.is(rangeRequest?.start, 0);
    t.is(rangeRequest?.end, 10);
});

test('parseRange header final bytes tests', t => {
    const rangeRequest = parseRangeRequest(1000, 'bytes=-10');
    t.is(rangeRequest?.start, 990);
    t.is(rangeRequest?.end, 999);
});

test('parseRange header from bytes tests', t => {
    const rangeRequest = parseRangeRequest(1000, 'bytes=900-');
    t.is(rangeRequest?.start, 900);
    t.is(rangeRequest?.end, 999);
});

