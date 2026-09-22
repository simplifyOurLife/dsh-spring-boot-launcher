// 实际 HTTP/WS 路由联调：认证拒绝不能调用启停，登录后才能读取快照。
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { apply } from '../src/index.js';
import { createWebHost } from './support/web-host.mjs';
const host = await createWebHost();
const disposers = [];
let shellCalls = 0;
apply({ ...host, tools: { register() {} },
  inject(names, activate) {
    assert.deepEqual(names, ['webServer', 'connection']);
    activate({ ...host, on(event, fn) { if (event === 'dispose') disposers.push(fn); } });
  },
  shell: { resolve: (spec) => spec, run() { shellCalls++; throw Error('不应执行命令'); } },
  on(event, fn) { if (event === 'dispose') disposers.push(fn); return () => {}; },
});
const origin = `http://127.0.0.1:${host.webServer.port}`;
try {
  for (const path of ['/status', '/logs', '/discover?dir=x', '/inspect?dir=x', '/start', '/stop']) {
    const method = ['/start', '/stop'].includes(path) ? 'POST' : 'GET';
    const res = await fetch(origin + '/spring-boot-launcher' + path, { method });
    assert.equal(res.status, 401, path + ' 缺少登录态应拒绝');
    await res.text();
  }
  let res = await host.fetch('/status', { headers: { origin: 'http://127.0.0.1:1' } });
  assert.equal(res.status, 403); await res.text();
  res = await host.fetch('/status', { headers: { origin } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).service, 'dsh-spring-boot-launcher');
  res = await host.fetch('/start', { method: 'POST', body: 'x'.repeat(65537) });
  assert.equal(res.status, 413); await res.text();
  res = await host.fetch('/start', { method: 'POST', body: '{' });
  assert.equal(res.status, 400); await res.text();
  assert.equal(shellCalls, 0);
  const wsUrl = origin.replace('http:', 'ws:') + '/spring-boot-launcher/ws';
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('error', reject);
    ws.on('open', () => { ws.close(); resolve(); });
  }), /401/);
  const ws = new WebSocket(wsUrl, { headers: { cookie: 'fixture=valid', origin } });
  const snapshot = await new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('message', (data) => resolve(JSON.parse(data)));
  });
  assert.equal(snapshot.type, 'snapshot');
  assert.deepEqual(snapshot.services, {});
  ws.terminate();
} finally {
  for (const dispose of disposers) dispose();
  host.close();
}
console.log('控制接口 HTTP/WS 联调测试通过');
