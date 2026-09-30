// 回归桌面版自定义协议：实时日志必须连接已认证 Host 的回环端口，而不是 ws://app。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const clientPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js');
const clientSource = readFileSync(clientPath, 'utf8');

async function socketUrlFor(location, port) {
  let loaderEntry;
  let socketUrl;
  const window = {
    location,
    __ModuleLoader__: { load(entry) { loaderEntry = entry; } },
  };
  vm.runInNewContext(clientSource, {
    window,
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
    fetch: async (path, options) => {
      assert.equal(path, '/spring-boot-launcher/status');
      assert.equal(options.credentials, 'same-origin');
      return { json: async () => ({ service: 'dsh-spring-boot-launcher', port }) };
    },
    WebSocket: class { constructor(url) { socketUrl = url; } },
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
  }, { filename: clientPath });
  assert.ok(loaderEntry);
  loaderEntry.factory((name) => {
    assert.equal(name, 'react');
    return { useState() {}, useEffect() {}, useRef() {}, createElement() {} };
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return socketUrl;
}

assert.equal(await socketUrlFor({ protocol: 'dsh-app:', host: 'app', port: '' }, 19387),
  'ws://127.0.0.1:19387/spring-boot-launcher/ws');
assert.equal(await socketUrlFor({ protocol: 'http:', host: '127.0.0.1:3080', port: '3080' }, 3080),
  'ws://127.0.0.1:3080/spring-boot-launcher/ws');
console.log('桌面与 Web 连接地址测试通过');
