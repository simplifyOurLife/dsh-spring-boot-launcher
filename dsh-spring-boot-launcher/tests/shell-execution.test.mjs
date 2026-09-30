import assert from 'node:assert/strict';
import { runShell, startShell } from '../src/shell-execution.js';

// 防止能力检测选到旧接口或失败后重复执行同一命令。
const request = { command: 'fixture', workdir: 'fixture-dir', timeoutMs: 8000 };
const modern = {
  resolve: spec => spec,
  async execute(spec) {
    assert.equal(spec.command, 'fixture');
    return { result: async () => ({ exitCode: 0, stdout: { text: '新版输出' } }) };
  },
  run() { throw new Error('不应调用旧版 run'); },
  start() { throw new Error('不应调用旧版 start'); },
};
assert.equal((await runShell(modern, request)).stdout.text, '新版输出');
assert.equal(typeof (await startShell(modern, request)).result, 'function');
const spawnFailure = new Error('宿主拒绝启动');
modern.execute = async () => { throw spawnFailure; };
await assert.rejects(runShell(modern, request), error => error === spawnFailure);
await assert.rejects(startShell(modern, request), error => error === spawnFailure);
modern.execute = async () => ({ result: async () => { throw spawnFailure; } });
await assert.rejects(runShell(modern, request), error => error === spawnFailure);

// 旧宿主维持原来的返回约定，同时长期服务也声明禁用超时。
const legacy = {
  resolve: spec => spec,
  run: async () => ({ exitCode: 0, stdout: '旧版输出' }),
  start(spec) {
    assert.equal(spec.onExpiry, 'none');
    return { status: 'running', pid: 123 };
  },
};
assert.equal((await runShell(legacy, request)).stdout, '旧版输出');
assert.equal((await startShell(legacy, request)).pid, 123);
assert.equal(request.onExpiry, undefined, '适配器不修改调用者输入');
await assert.rejects(runShell({ resolve: spec => spec }, request), /缺少 execute\/run/);
await assert.rejects(startShell({ resolve: spec => spec }, request), /缺少 execute\/start/);
console.log('新旧 Shell 能力选择与失败不重试测试通过');
