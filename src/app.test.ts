import test from 'ava';
import { MyBufferCollection } from './MyBufferCollection.js';
import { MyBuffer } from "./MyBuffer.js";


test('parseElementAttributes should return valid attributes', t => {
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