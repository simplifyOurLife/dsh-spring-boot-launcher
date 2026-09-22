// 回归：真实 DSH 返回 CollectedOutput 对象，不能对 stderr 对象调用 trim。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const start = source.indexOf('async function probeJdkVersion(');
const end = source.indexOf('\n/**', start);
const warnings = [];
const probe = vm.runInNewContext(source.slice(start, end) + '; probeJdkVersion', { join, console: { warn: (...args) => warnings.push(args) } });
const shell = {
  resolve: (spec) => spec,
  run: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: 'java version "1.8.0_421"\nJava(TM) SE Runtime Environment' } }),
};
assert.equal(await probe({ shell }, null, 'D:\\fixture\\jdk8'), 'java version "1.8.0_421"');
shell.run = async () => ({ exitCode: 0, stdout: { text: 'openjdk 21.0.2 2024-01-16' }, stderr: { text: '' } });
assert.equal(await probe({ shell }, null, 'D:\\fixture\\jdk21'), 'openjdk 21.0.2 2024-01-16');
shell.run = async () => ({ exitCode: 0, stderr: { text: 'Picked up JAVA_TOOL_OPTIONS: -Xmx1g\njava version "1.8.0_421"' } });
assert.equal(await probe({ shell }, null, 'D:\\fixture\\jdk8'), 'java version "1.8.0_421"');
shell.run = async () => ({ exitCode: 0, stderr: 'openjdk version "17.0.12"' });
assert.equal(await probe({ shell }, null, 'D:\\fixture\\jdk17'), 'openjdk version "17.0.12"');
shell.run = async () => ({ exitCode: 1, stderr: { text: 'java version "1.8.0_421"' } });
assert.equal(await probe({ shell }, null, 'D:\\fixture\\jdk8'), undefined);
shell.run = async () => { throw new Error('模拟拒绝访问'); };
assert.equal(await probe({ shell }, null, 'D:\\fixture\\jdk8'), undefined);
assert.equal(warnings.length, 2, '失败应记录原因，不再静默吞掉');
console.log('真实 DSH JDK 版本输出测试通过');
