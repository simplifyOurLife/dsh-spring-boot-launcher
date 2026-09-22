// 每个套件使用独立子进程与唯一临时根目录，网络测试由 OS 分配空闲端口。
// 测试专用依赖 hook 不会加载本机 DSH 安装。
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here)
  .filter((f) => (f.startsWith("dsh-bl-smoke-") || f.endsWith('.test.mjs')) && f.endsWith(".mjs"))
  .sort();

let failed = 0;
for (const suite of suites) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-suite-'));
  const env = { ...process.env, TEMP: fixtureRoot, TMP: fixtureRoot, DSH_HOME: join(fixtureRoot, 'no-dsh-install') };
  console.log(`\n━━━ ${suite}`);
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(here, 'support/register.mjs')).href, join(here, suite)], {
    env, stdio: "inherit", timeout: 120_000,
  });
  const ok = r.status === 0;
  rmSync(fixtureRoot, { recursive: true, force: true });
  if (!ok) failed++;
  console.log(`${ok ? "✓ PASS" : "✗ FAIL (" + r.status + ")"} ${suite}`);
}
console.log(`\n${failed === 0 ? "ALL " + suites.length + " SUITES PASSED" : failed + " SUITE(S) FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
