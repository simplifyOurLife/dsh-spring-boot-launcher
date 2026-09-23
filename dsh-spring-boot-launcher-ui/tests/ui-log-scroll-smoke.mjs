// 回归：日志新增和搜索导航重渲染不能抢走用户的滚动位置；只有显式按钮跳到底部。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const clientPath = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
const hookState = new Map();
const pendingEffects = [];
let activeComponent;
let hookIndex = 0;
let loaderEntry;
let socket;
let pendingNavigation;

function slotsFor(component) {
  if (!hookState.has(component)) hookState.set(component, []);
  return hookState.get(component);
}

function renderComponent(Component, props = {}) {
  const previousComponent = activeComponent;
  const previousIndex = hookIndex;
  activeComponent = Component;
  hookIndex = 0;
  try { return Component(props); }
  finally { activeComponent = previousComponent; hookIndex = previousIndex; }
}

const React = {
  useState(initial) {
    const slots = slotsFor(activeComponent);
    const index = hookIndex++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
  },
  useRef(initial) {
    const slots = slotsFor(activeComponent);
    const index = hookIndex++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  },
  useEffect(effect, deps) {
    const slots = slotsFor(activeComponent);
    const index = hookIndex++;
    const before = slots[index];
    if (!before || !deps || deps.some((value, i) => !Object.is(value, before[i]))) {
      slots[index] = deps;
      pendingEffects.push(effect);
    }
  },
  createElement(type, props, ...children) {
    if (typeof type === "function") return renderComponent(type, props);
    return { type, props: { ...(props || {}), children } };
  },
};

function flatten(value, out = []) {
  if (Array.isArray(value)) { for (const item of value) flatten(item, out); return out; }
  if (value && typeof value === "object" && value.type) {
    out.push(value);
    flatten(value.props.children, out);
  }
  return out;
}

function flushEffects() {
  for (const effect of pendingEffects.splice(0)) effect();
}

const styles = new Map();
const context = {
  console, URL, AbortSignal, Promise, Set, Map, JSON, Date, Math, String, Object, Array, RegExp, encodeURIComponent,
  setTimeout(fn, ms) { if (ms === 30) pendingNavigation = fn; return 1; },
  clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
  fetch: async () => ({ json: async () => ({ service: "dsh-spring-boot-launcher" }) }),
  WebSocket: class { constructor() { socket = this; } close() {} },
  localStorage: { getItem: () => null, setItem() {} },
  document: {
    getElementById: (id) => styles.get(id) || null,
    createElement: () => ({}),
    head: { appendChild: (node) => { if (node.id) styles.set(node.id, node); } },
  },
  window: {
    location: { host: "127.0.0.1:3000", port: "3000", protocol: "http:" },
    __ModuleLoader__: { load: (entry) => { loaderEntry = entry; } },
    addEventListener() {}, removeEventListener() {},
  },
};
context.window.window = context.window;
vm.runInNewContext(readFileSync(clientPath, "utf8"), context, { filename: clientPath });
const client = loaderEntry.factory((name) => {
  if (name === "react") return React;
  throw new Error(`unexpected require: ${name}`);
});
const registered = {};
client.apply({
  workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe() {} } },
  slots: { inject(_name, factory) { factory(); }, register(meta, Component) { registered[meta.name] = Component; return () => {}; } },
});
await new Promise((resolve) => setTimeout(resolve, 0));
renderComponent(registered["sidebar.footer.action"]).props.onClick();
assert.ok(socket, "面板应建立日志 WebSocket");
socket.onmessage({ data: JSON.stringify({ type: "snapshot", services: { demo: { projectKey: "demo", projectDir: "D:\\demo", running: true, status: "running" } } }) });
socket.onmessage({ data: JSON.stringify({ type: "logSnapshot", projectKey: "demo", text: "needle first\nother\nneedle second" }) });

const pane = {
  scrollTop: 120,
  scrollHeight: 1000,
  querySelector(selector) {
    const match = /data-m="(\d+)"/.exec(selector);
    return match ? { scrollIntoView: () => { this.scrollTop = Number(match[1]) === 0 ? 200 : 400; } } : null;
  },
};
function renderPanel() { return flatten(renderComponent(registered["shell.overlay"])); }
let nodes = renderPanel();
nodes.find((node) => node.type === "pre" && node.props.className === "blv3-logview").props.ref.current = pane;
flushEffects();
assert.equal(pane.scrollTop, 120, "打开面板不应强制滚动已有日志");

socket.onmessage({ data: JSON.stringify({ type: "log", projectKey: "demo", delta: "\nmore output" }) });
nodes = renderPanel();
flushEffects();
assert.equal(pane.scrollTop, 120, "新日志到来时应保留手动滚动位置");

let input = nodes.find((node) => node.type === "input" && node.props.className === "blv3-search");
input.props.onChange({ target: { value: "needle" } });
nodes = renderPanel();
input = nodes.find((node) => node.type === "input" && node.props.className === "blv3-search");
input.props.onKeyDown({ key: "Enter" });
nodes = renderPanel();
flushEffects();
assert.equal(pane.scrollTop, 200, "新搜索应定位首个命中，而非日志末尾");

nodes.find((node) => node.type === "button" && node.props.title === "下一处").props.onClick();
nodes = renderPanel();
flushEffects();
pendingNavigation();
assert.equal(pane.scrollTop, 400, "下一处应定位对应命中");
socket.onmessage({ data: JSON.stringify({ type: "log", projectKey: "demo", delta: "\nlatest" }) });
nodes = renderPanel();
flushEffects();
assert.equal(pane.scrollTop, 400, "定位命中后新日志不应抢走阅读位置");

const tailButton = nodes.find((node) => node.type === "button" && node.props.title === "滚动到日志末尾");
assert.ok(tailButton, "日志工具栏应提供显式滚动到末尾按钮");
tailButton.props.onClick();
assert.equal(pane.scrollTop, pane.scrollHeight, "点击按钮后应滚动到日志末尾");
console.log("UI LOG SCROLL SMOKE TESTS PASSED");
