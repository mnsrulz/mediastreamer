import { log } from 'node:console';
import { EventEmitter } from 'node:events';

const em = new EventEmitter();
em.on('test', ()=>{
    log('event emit test called')
})

em.emit('test');

log(`my log`)


const bf = Buffer.from('01234567890');
const nf = bf.subarray(3,9).subarray(0,2)

log(nf.toString())