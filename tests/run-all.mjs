import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 根入口测试沿用 Host 专项测试的外部依赖钩子，并隔离本机 DSH 安装。
await import('../dsh-spring-boot-launcher/tests/support/register.mjs');
const previousDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = join(tmpdir(), 'dsh-root-contract-' + randomUUID());
try {
  await import('./bundle-contract.test.mjs');
  await import('./package-contents.test.mjs');
} finally {
  if (previousDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousDshHome;
}

console.log('ALL ROOT CONTRACT TESTS PASSED');
