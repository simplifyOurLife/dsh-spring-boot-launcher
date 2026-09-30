import assert from 'node:assert/strict';
import {pumpProcess} from '../src/log-pump.js';
const output = ['boot', '', 'shutdown', '', ''];
const proc = {status:'running',readOutput(){ const delta=output.shift() || ''; this.status='completed'; return {delta}; }};
const events=[];
await pumpProcess(proc,{append:delta=>events.push(delta),onEnd:status=>events.push(status),interval:1,drainInterval:1});
assert.deepEqual(events,['boot','shutdown','completed']);
// 新版 kill 立即切换状态，但 done 尚未完成时不能关闭日志。
let finish;
let settled = false;
let ended = false;
let delivered = false;
const delayed = {
  status: 'killed',
  done: new Promise(resolve => { finish = () => { settled = true; resolve(); }; }),
  readOutput() {
    const delta = settled && !delivered ? '延迟退出日志' : '';
    if (delta) delivered = true;
    return { delta, lossy: false };
  },
};
const delayedEvents = [];
const pumping = pumpProcess(delayed, {
  append: delta => delayedEvents.push(delta),
  onEnd: () => { ended = true; }, interval: 1, drainInterval: 1,
});
await new Promise(resolve => setTimeout(resolve, 20));
try {
  assert.equal(ended, false, '宿主尚未完成退出，日志不能提前结束');
} finally { finish(); }
await pumping;
assert.deepEqual(delayedEvents, ['延迟退出日志']);
console.log('日志 pump 尾部同步测试通过');
