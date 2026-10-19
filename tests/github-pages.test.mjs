// 删除首页或破坏复制反馈时应失败；不把页面静态契约当作真实浏览器验收。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../docs/', import.meta.url);
assert.ok(existsSync(new URL('index.html', root)), 'Pages 的 /docs 发布目录必须包含 index.html');
const html = readFileSync(new URL('index.html', root), 'utf8');
assert.match(html, /lang="zh-CN"/);
assert.match(html, /SpringBoot/);
assert.match(html, /dsh plugin --profile web add github:simplifyOurLife\/dsh-spring-boot-launcher/);
assert.match(html, /尚未验证/);
assert.ok(existsSync(new URL('.nojekyll', root)), '纯静态页面无需 Jekyll 处理');
for (const [, path] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  if (/^https?:/.test(path)) continue;
  assert.ok(!path.startsWith('/'), `资源必须适配 Pages 仓库子路径：${path}`);
  assert.ok(existsSync(new URL(path, root)), `资源缺失：${path}`);
}
for (const [, anchor] of html.matchAll(/href="#([^"]+)"/g)) {
  assert.ok(html.includes(`id="${anchor}"`), `锚点不存在：${anchor}`);
}
const script = readFileSync(new URL('site.js', root), 'utf8');
async function clickCopy(clipboard) {
  let onClick;
  const button = { disabled: false, textContent: '复制命令', addEventListener: (_name, handler) => { onClick = handler; } };
  const code = { textContent: 'dsh plugin --profile web add github:simplifyOurLife/dsh-spring-boot-launcher', focus() {} };
  const status = { textContent: '' };
  vm.runInNewContext(script, { document: { getElementById: id => ({ 'copy-command': button, 'install-command': code, 'copy-status': status })[id] }, navigator: { clipboard } });
  assert.equal(typeof onClick, 'function');
  await onClick();
  assert.equal(button.disabled, false, '复制后按钮应恢复可操作');
  return { status, button, code };
}
let copied;
const success = await clickCopy({ writeText: async text => { copied = text; } });
assert.equal(copied, success.code.textContent);
assert.match(success.status.textContent, /已复制/);
const denied = await clickCopy({ writeText: async () => { throw new Error('denied'); } });
assert.match(denied.status.textContent, /手动/);
const unavailable = await clickCopy(undefined);
assert.match(unavailable.status.textContent, /手动/);
console.log('GitHub Pages 资源、内容及复制交互测试通过');
