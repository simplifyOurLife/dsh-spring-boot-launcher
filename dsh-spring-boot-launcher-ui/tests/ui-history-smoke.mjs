// UI 冒烟测试：最近路径只作为“手动输入其他路径”的辅助选项，
// 不再占用工作区项目区域；选择后应填入路径并触发项目检查。
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, "..", "lib", "client.js");
const recentDirs = [
  "D:\\work\\legacy-service",
  "D:\\work\\another-service",
];

let loaderEntry;
const storage = new Map([
  ["dsh-backend-launcher:settings", JSON.stringify({ recentDirs: ["D:\\old\\must-not-load"] })],
  ["dsh-spring-boot-launcher:settings", JSON.stringify({ recentDirs })],
]);

const hookState = new Map();
let activeComponent = null;
let hookIndex = 0;

function renderComponent(Component, props) {
  const previousComponent = activeComponent;
  const previousIndex = hookIndex;
  activeComponent = Component;
  hookIndex = 0;
  try {
    return Component(props || {});
  } finally {
    activeComponent = previousComponent;
    hookIndex = previousIndex;
  }
}

function slotFor(component) {
  let slots = hookState.get(component);
  if (!slots) {
    slots = [];
    hookState.set(component, slots);
  }
  return slots;
}

const React = {
  useState(initial) {
    const slots = slotFor(activeComponent);
    const index = hookIndex++;
    if (!(index in slots)) {
      slots[index] = typeof initial === "function" ? initial() : initial;
    }
    return [slots[index], (next) => {
      slots[index] = typeof next === "function" ? next(slots[index]) : next;
    }];
  },
  useRef(initial) {
    const slots = slotFor(activeComponent);
    const index = hookIndex++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  },
  useEffect() {},
  createElement(type, props, ...children) {
    if (typeof type === "function") return renderComponent(type, props);
    return { type, props: { ...(props || {}), children } };
  },
};

const styleNodes = new Map();
const context = {
  console,
  URL,
  AbortSignal,
  Promise,
  Set,
  Map,
  JSON,
  Date,
  Math,
  String,
  Object,
  Array,
  RegExp,
  encodeURIComponent,
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    if (ms >= 1000) timer.unref();
    return timer;
  },
  clearTimeout,
  setInterval: () => 1,
  clearInterval() {},
  fetch: async (url) => ({
    json: async () => String(url).includes("/status")
      ? { service: "dsh-spring-boot-launcher" }
      : { matched: true, profiles: ["dev"] },
  }),
  WebSocket: class {
    constructor() { this.readyState = 1; }
    close() {}
  },
  localStorage: {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)),
  },
  document: {
    getElementById: (id) => styleNodes.get(id) || null,
    createElement: () => ({}),
    head: { appendChild: (node) => { if (node.id) styleNodes.set(node.id, node); } },
  },
  window: {
    location: { host: '127.0.0.1:3000', port: '3000', protocol: 'http:' },
    __ModuleLoader__: { load: (entry) => { loaderEntry = entry; } },
    addEventListener() {},
    removeEventListener() {},
  },
};
context.window.window = context.window;
vm.runInNewContext(readFileSync(clientPath, "utf8"), context, { filename: clientPath });
assert.ok(loaderEntry, "客户端模块应注册到 ModuleLoader");

const clientModule = loaderEntry.factory((name) => {
  if (name === "react") return React;
  throw new Error(`unexpected require: ${name}`);
});
// 等待控制端口探测完成，使最近路径选择走真实的 inspect 请求分支。
await new Promise((resolve) => setTimeout(resolve, 0));

const registered = {};
const ctx = {
  workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe() {} } },
  slots: {
    inject(_name, factory) { factory(); },
    register(meta, Component) {
      registered[meta.name] = Component;
      return () => {};
    },
  },
};
clientModule.apply(ctx);

const entryTree = renderComponent(registered["sidebar.footer.action"]);
entryTree.props.onClick();

function flatten(value, out = []) {
  if (value === null || value === undefined || value === false) return out;
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, out);
    return out;
  }
  if (typeof value === "object" && value.type) {
    out.push(value);
    flatten(value.props && value.props.children, out);
  }
  return out;
}

function textOf(value) {
  if (value === null || value === undefined || value === false) return "";
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (typeof value === "object" && value.type) return textOf(value.props.children);
  return String(value);
}

assert.ok(textOf(entryTree).includes('Spring Boot'), '侧栏入口应显示 Spring Boot');

let panelTree = renderComponent(registered["shell.overlay"]);
assert.ok(textOf(panelTree).includes('Spring Boot Services'), '面板标题应显示 Spring Boot Services');
assert.ok(!textOf(panelTree).includes('must-not-load'), '不得读取旧存储键');
let nodes = flatten(panelTree);
assert.ok(
  !nodes.some((node) => textOf(node).includes("·历史")),
  "最近路径不应再以无反馈的“·历史”标签显示在工作区项目区域",
);

const manualToggle = nodes.find((node) =>
  node.props.className === "blv3-advtoggle" &&
  typeof node.props.onClick === "function" &&
  textOf(node).includes("手动输入其他路径"),
);
assert.ok(manualToggle, "应显示手动路径折叠入口");
manualToggle.props.onClick();

panelTree = renderComponent(registered["shell.overlay"]);
nodes = flatten(panelTree);
const recentSelect = nodes.find((node) => node.props && node.props["data-recent-paths"] === true);
assert.ok(recentSelect, "展开手动路径后应显示最近使用路径下拉框");
assert.ok(textOf(recentSelect).includes("legacy-service"), "下拉框应展示最近项目名称");

recentSelect.props.onChange({ target: { value: recentDirs[0] } });
panelTree = renderComponent(registered["shell.overlay"]);
nodes = flatten(panelTree);
const pathInput = nodes.find((node) => node.type === "input" && node.props.placeholder === "D:\\path\\to\\spring-boot\\project");
assert.strictEqual(pathInput.props.value, recentDirs[0], "选择最近路径后应填入手动路径输入框");

const recentSelectAgain = nodes.find((node) => node.props && node.props["data-recent-paths"] === true);
recentSelectAgain.props.onChange({ target: { value: recentDirs[1] } });
panelTree = renderComponent(registered["shell.overlay"]);
nodes = flatten(panelTree);
const pathInputAgain = nodes.find((node) => node.type === "input" && node.props.placeholder === "D:\\path\\to\\spring-boot\\project");
assert.strictEqual(pathInputAgain.props.value, recentDirs[1], "连续选择最近路径时检查方法不应被状态值覆盖");

console.log("UI HISTORY SMOKE TESTS PASSED");
