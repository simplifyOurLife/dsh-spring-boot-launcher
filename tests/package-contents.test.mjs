import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootPath = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath
  ?? (process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : undefined);
const command = npmCli ? process.execPath : 'npm';
const args = npmCli
  ? [npmCli, 'pack', '--dry-run', '--json']
  : ['pack', '--dry-run', '--json'];
const result = spawnSync(command, args, {
  cwd: rootPath,
  encoding: 'utf8',
});

assert.equal(result.status, 0, result.stderr || result.stdout);
const report = JSON.parse(result.stdout);
assert.equal(report.length, 1, 'npm pack 应只生成一个包报告');
const paths = new Set(report[0].files.map((file) => file.path.replaceAll('\\', '/')));

for (const required of [
  'package.json',
  'src/index.js',
  'cordis.patch.yml',
  'dsh-spring-boot-launcher/src/index.js',
  'dsh-spring-boot-launcher-ui/lib/client.js',
  'README.md',
  'LICENSE',
  'SECURITY.md',
]) {
  assert.ok(paths.has(required), `发行包缺少必要文件：${required}`);
}

for (const excludedPrefix of ['tests/', '.idea/', '.superpowers/', '.release-audit/']) {
  assert.equal(
    [...paths].some((path) => path.startsWith(excludedPrefix)),
    false,
    `发行包不应包含：${excludedPrefix}`,
  );
}

console.log('npm 发行包内容契约测试通过');