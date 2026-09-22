// 防止无上限请求占用内存，或慢请求长期占用连接。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readBody } from '../src/control-body.js';

const req = new EventEmitter();
req.headers = {};
const result = readBody(req, { maxBytes: 4, timeoutMs: 100 });
req.emit('data', Buffer.from('12345'));
req.emit('end');
await assert.rejects(result, (error) => error.statusCode === 413, '超大请求必须拒绝');
assert.equal(req.listenerCount('data'), 0, '结束后清理读取监听器');
const slow = new EventEmitter();
await assert.rejects(readBody(slow, { timeoutMs: 5 }), (e) => e.statusCode === 408);
for (const event of ['aborted', 'close', 'error']) {
  const interrupted = new EventEmitter();
  const pending = readBody(interrupted);
  interrupted.emit(event, new Error('连接断开'));
  await assert.rejects(pending, (e) => e.statusCode === 400);
}
const declared = new EventEmitter();
declared.headers = { 'content-length': '100' };
await assert.rejects(readBody(declared, { maxBytes: 4 }), (e) => e.statusCode === 413);
const normal = new EventEmitter();
const text = readBody(normal, { maxBytes: 3 });
const utf8 = Buffer.from('中');
normal.emit('data', utf8.subarray(0, 1));
normal.emit('data', utf8.subarray(1));
normal.emit('end');
assert.equal(await text, '中', '分块 UTF-8 不可损坏，恰好达到上限应成功');
console.log('控制请求体限制测试通过');
