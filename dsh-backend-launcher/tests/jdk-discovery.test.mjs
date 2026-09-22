// 回归：JAVA_HOME 未设置但 PATH 有 JDK 时，不能报告找不到匹配版本。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectJdkCandidates } from '../src/jdk-discovery.js';
const fixture = mkdtempSync(join(tmpdir(), 'jdk-path-'));
try {
  const jdk = join(fixture, 'jdk8');
  mkdirSync(join(jdk, 'bin'), { recursive: true });
  writeFileSync(join(jdk, 'bin/java.exe'), 'fixture');
  const env = { Path: `;"${join(jdk, 'bin')}";${join(jdk, 'bin')};`, USERPROFILE: fixture };
  const found = detectJdkCandidates(env).filter((candidate) => candidate.path === jdk);
  assert.equal(found.length, 1, '兼容 Path 大小写、引号和重复项');
  assert.equal(found[0].source, 'PATH');
  const preferred = detectJdkCandidates({ ...env, JAVA_HOME: jdk });
  assert.equal(preferred[0].path, jdk);
  assert.equal(preferred[0].source, 'JAVA_HOME', '显式 JAVA_HOME 仍优先');
} finally { rmSync(fixture, { recursive: true, force: true }); }
console.log('PATH JDK 发现测试通过');
