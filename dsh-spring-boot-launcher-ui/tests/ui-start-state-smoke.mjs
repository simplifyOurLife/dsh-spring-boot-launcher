// UI 回归测试：首次从工作区项目卡片启动服务后，即使 WebSocket 状态消息
// 先于 HTTP 响应到达或暂时缺少 projectDir，/start 的成功响应也必须把
// 运行状态关联回原项目卡片，使按钮从 Start 切换为 Stop。
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, "..", "lib", "client.js");
const projectDir = "D:\\work\\demo-service";
const projectKey = "demo-service-key";

let loaderEntry;
let occupiedPort = 9410;
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
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
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
    if (ms >= 1000) timer.unref(); // UI 后台重试/保护定时器不拖住测试进程。
    return timer;
  },
  clearTimeout,
  setInterval: () => 1,
  clearInterval() {},
  fetch: async (url, options = {}) => {
    const value = String(url);
    assert.ok(value.startsWith('/spring-boot-launcher/'), '所有请求必须走 Spring Boot 同源认证路径');
    assert.equal(options.credentials, 'same-origin');
    if (value.endsWith("/status")) {
      return { json: async () => ({ service: "dsh-spring-boot-launcher" }) };
    }
    if (value.includes("/discover?")) {
      return {
        json: async () => ({
          projects: [{ dir: projectDir, name: "demo-service", profiles: ["dev"], activeProfile: "dev", externalPort: occupiedPort }],
        }),
      };
    }
    if (value.endsWith("/start") && options.method === "POST") {
      return {
        json: async () => ({
          projectKey,
          status: "running",
          port: 8080,
          mode: "dev-run",
          pid: 1234,
          health: "detached",
        }),
      };
    }
    return { json: async () => ({ matched: true, profiles: ["dev"], activeProfile: "dev" }) };
  },
  WebSocket: class {
    constructor(url) {
      assert.equal(url, 'ws://127.0.0.1:3000/spring-boot-launcher/ws');
      this.readyState = 1;
    }
    close() {}
  },
  localStorage: { getItem: () => null, setItem() {} },
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
assert.equal(loaderEntry.id, "dsh-spring-boot-launcher");

const clientModule = loaderEntry.factory((name) => {
  if (name === "react") return React;
  throw new Error(`unexpected require: ${name}`);
});

const registered = {};
const ctx = {
  workspaces: {
    list: {
      getSnapshot: () => ({ items: [{ path: "D:\\work", title: "work" }] }),
      subscribe() {},
    },
  },
  slots: {
    inject(_name, factory) { factory(); },
    register(meta, Component) {
      registered[meta.name] = Component;
      return () => {};
    },
  },
};
clientModule.apply(ctx);
await new Promise((resolve) => setTimeout(resolve, 0));

const entryTree = renderComponent(registered["sidebar.footer.action"]);
entryTree.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));

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
let nodes = flatten(panelTree);
const conflictButton = nodes.find((node) => node.type === "button" && textOf(node) === "端口占用");
assert.ok(conflictButton && conflictButton.props.disabled, "未知进程占用端口时应提示端口占用并阻止启动");
assert.ok(!textOf(panelTree).includes("外部运行"), "不能将 TCP 连通推断成服务外部运行");
assert.ok(!nodes.some((node) => /blv3-card.* running/.test(node.props.className || "")), "端口占用不能标为运行状态");
occupiedPort = null;
nodes.find((node) => node.type === "button" && textOf(node).includes("重新扫描")).props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
panelTree = renderComponent(registered["shell.overlay"]);
nodes = flatten(panelTree);
const startButton = nodes.find((node) =>
  node.type === "button" && node.props.className === "blv3-mini start" && textOf(node) === "Start",
);
assert.ok(startButton, "工作区项目卡片应显示 Start 按钮");

startButton.props.onClick({ stopPropagation() {} });
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));

panelTree = renderComponent(registered["shell.overlay"]);
nodes = flatten(panelTree);
const stopButton = nodes.find((node) =>
  node.type === "button" && node.props.className === "blv3-mini stop" && textOf(node) === "Stop",
);
assert.ok(stopButton, "启动成功响应后，原项目卡片按钮应从 Start 切换为 Stop");

console.log("UI START STATE SMOKE TESTS PASSED");
