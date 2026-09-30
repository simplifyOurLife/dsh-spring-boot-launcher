// 回归：新版宿主只有 execute，没有 start/run，也不公开 PID。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.js';

const root = mkdtempSync(join(tmpdir(), 'spring-boot-current-shell-'));
const jdk = join(root, 'jdk');
const dir = join(root, 'app');
const previousJavaHome = process.env.JAVA_HOME;
const tools = new Map();
let launchSpec;
let launchCount = 0;
let killed = false;
let tailRead = false;
let probeFailure = false;
const proc = {
  status: 'running', exitCode: null, signal: null,
  done: Promise.resolve(), observed: {},
  readOutput() {
    if (this.status === 'running') return { delta: '', lossy: false };
    if (tailRead) return { delta: '', lossy: false };
    tailRead = true;
    return { delta: '新版宿主停止后的日志\n', lossy: false };
  },
  kill() { killed = true; this.status = 'killed'; return true; },
  result() { throw new Error('长期服务不应等待 result()'); },
};
const ctx = {
  tools: { register: tool => tools.set(tool.name, tool) },
  on: () => () => {},
  shell: {
    resolve: spec => ({ timeoutMs: 50, onExpiry: 'kill', ...spec }),
    async execute(spec) {
      if (spec.command.includes('-version')) {
        if (probeFailure) throw new Error('windows-acl-run: SetNamedSecurityInfoW failed (Win32 5)');
        return { result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: 'openjdk version "17.0.12"' } }) };
      }
      launchSpec = spec;
      launchCount++;
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(spec.onExpiry, 'none', '长期服务不得使用宿主默认超时终止策略');
      return proc;
    },
  },
};
try {
  mkdirSync(join(jdk, 'bin'), { recursive: true });
  writeFileSync(join(jdk, 'bin', 'java.exe'), 'fixture');
  process.env.JAVA_HOME = jdk;
  mkdirSync(join(dir, 'src/main/java/demo'), { recursive: true });
  mkdirSync(join(dir, 'target/classes'), { recursive: true });
  mkdirSync(join(dir, 'target/lib'), { recursive: true });
  writeFileSync(join(dir, 'pom.xml'), '<project><artifactId>app</artifactId><parent><artifactId>spring-boot-starter-parent</artifactId><version>2.7.18</version></parent></project>');
  writeFileSync(join(dir, 'src/main/java/demo/App.java'), 'package demo; @SpringBootApplication public class App { public static void main(String[] args) {} }');
  writeFileSync(join(dir, 'target/classes/App.class'), 'fixture');
  writeFileSync(join(dir, 'target/lib/dep.jar'), 'fixture');
  apply(ctx);
  const inspect = await tools.get('spring_boot_inspect').execute({ dir }, {});
  assert.ok(inspect.detectedJdks.some(item => item.detectedVersion === 'openjdk version "17.0.12"'), '新版 result() 输出应能识别 JDK');
  probeFailure = true;
  const failed = await tools.get('spring_boot_start').execute({ dir, detach: true }, {});
  assert.equal(failed.error.code, 'JDK_PROBE_FAILED', '执行环境失败不能误报 JDK 版本不匹配');
  assert.match(failed.error.message, /Win32 5/);
  assert.ok(failed.error.candidates.every(item => item.probeError));
  assert.equal(launchCount, 0, '探测失败时不能继续启动');
  probeFailure = false;
  const results = await Promise.all([0, 1].map(() =>
    tools.get('spring_boot_start').execute({ dir, mode: 'direct-classpath', detach: true }, {})));
  const started = results.find(result => !result.isError);
  assert.equal(launchCount, 1, '异步 execute 的并发启动仍只能创建一个服务');
  assert.equal(results.find(result => result.isError)?.error.code, 'ALREADY_RUNNING');
  assert.ok(started, '应有一个启动成功');
  assert.ok(!started.isError, JSON.stringify(started.error));
  assert.equal(started.pid, null, '宿主未公开 PID 时明确返回 null');
  assert.equal(launchSpec.workdir, dir);
  assert.equal(launchSpec.sandboxPolicy.mode, 'danger-full-access');
  const stopped = await tools.get('spring_boot_stop').execute({ dir });
  assert.equal(stopped.stopped, true);
  assert.equal(killed, true, '无 PID 时通过宿主句柄停止，不猜测端口进程');
  const logs = await tools.get('spring_boot_logs').execute({ dir, lines: 50 });
  assert.ok(logs.logs.includes('新版宿主停止后的日志'), '停止后仍应排空尾部日志');
} finally {
  if (previousJavaHome === undefined) delete process.env.JAVA_HOME;
  else process.env.JAVA_HOME = previousJavaHome;
  proc.kill();
  rmSync(root, { recursive: true, force: true });
}
console.log('新版 Shell 检查、启动、停止与日志回归测试通过');
