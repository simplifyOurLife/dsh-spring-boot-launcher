// 插件详情页应提供能力说明，并复用现有服务管理面板。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let entry;
const React = {
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect() {},
  useRef: (value) => ({ current: value }),
  createElement(type, props, ...children) {
    return typeof type === 'function'
      ? type(props || {})
      : { type, props: { ...props, children } };
  },
};
const styles = new Map();
const context = {
  console, URL, AbortSignal,
  setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  fetch: async () => ({ ok: true, json: async () => ({ service: 'dsh-spring-boot-launcher' }) }),
  WebSocket: class { close() {} },
  localStorage: { getItem: () => null, setItem() {} },
  document: {
    getElementById: (id) => styles.get(id), createElement: () => ({}),
    head: { appendChild: (node) => styles.set(node.id, node) },
  },
  window: {
    location: { protocol: 'http:', host: '127.0.0.1:3000', port: '3000' },
    __ModuleLoader__: { load: (value) => { entry = value; } },
    addEventListener() {}, removeEventListener() {},
  },
};
vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), context);
const client = entry.factory((name) => {
  assert.equal(name, 'react');
  return React;
});
const registered = new Map();
client.apply({ slots: {
  inject(_name, factory) { factory(); },
  register(meta, render) { registered.set(meta.name, { meta, render }); return () => {}; },
} });
const detail = registered.get('plugins.bundle.config');
assert.ok(detail, '应注册插件详情卡片');
assert.equal(detail.meta.key, 'dsh-spring-boot-launcher', '仅匹配当前 bundle');
assert.equal(detail.render({ view: 'summary' }), null, '列表摘要不应展示完整卡片');
const tree = detail.render({ view: 'detail' });
const text = JSON.stringify(tree);
for (const label of ['Spring Boot 启动器', 'Profile', '实时日志', 'JDK', 'Maven', 'Windows 11']) {
  assert.ok(text.includes(label), `详情缺少说明：${label}`);
}
function flatten(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  return [node, ...flatten(node.props?.children)];
}
const button = flatten(tree).find((node) => node.type === 'button'
  && JSON.stringify(node.props.children).includes('打开服务管理面板'));
assert.ok(button, '应提供管理面板入口');
const overlay = registered.get('shell.overlay').render;
assert.equal(overlay(), null, '管理面板初始关闭');
button.props.onClick();
assert.ok(overlay(), '点击详情按钮应打开现有管理面板');
console.log('插件详情卡片与管理入口测试通过');
