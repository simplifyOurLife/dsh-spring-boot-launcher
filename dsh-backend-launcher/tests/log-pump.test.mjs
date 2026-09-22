import assert from 'node:assert/strict';
import {pumpProcess} from '../src/log-pump.js';
const output = ['boot', '', 'shutdown', '', ''];
const proc = {status:'running',readOutput(){ const delta=output.shift() || ''; this.status='completed'; return {delta}; }};
const events=[];
await pumpProcess(proc,{append:delta=>events.push(delta),onEnd:status=>events.push(status),interval:1,drainInterval:1});
assert.deepEqual(events,['boot','shutdown','completed']);
console.log('日志 pump 尾部同步测试通过');
