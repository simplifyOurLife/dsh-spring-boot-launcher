// 捕获未认证请求进入处理器、upgrade 绕过认证和错误的跨源放行。
import assert from 'node:assert/strict';
import { mountControlTransport, requestRejection } from '../src/control-transport.js';

let httpRoute, upgradeRoute, disposed = 0, handled = 0, upgraded = 0;
const webServer = {
  host: '127.0.0.1', port: 3000,
  register(route) { httpRoute = route; return () => disposed++; },
  registerUpgrade(route) { upgradeRoute = route; return () => disposed++; },
};
// 只替代宿主登录验证，测试插件是否在所有入口执行它。不是 cookie 密码学测试。
const connection = { requestRejection: (req) => req.headers.cookie === 'fixture=valid' ? undefined : 401 };
const req = (headers = {}) => ({ url: '/spring-boot-launcher/status', headers: { host: '127.0.0.1:3000', ...headers } });
for (const headers of [
  { origin: 'http://127.0.0.1:9999' }, { origin: 'null' },
  { host: 'attacker.example:3000' }, { host: '127.0.0.1:9999' },
  { host: '127.0.0.1:3000/path' }, { 'sec-fetch-site': 'cross-site' },
]) assert.equal(requestRejection(req({ cookie: 'fixture=valid', ...headers }), webServer, connection), 403);
assert.equal(requestRejection(req(), webServer, connection), 401);
assert.equal(requestRejection(req({ cookie: 'fixture=valid' }), webServer, {}), 503);
assert.equal(requestRejection(req({ cookie: 'fixture=valid', origin: 'http://127.0.0.1:3000' }), webServer, connection), undefined);
assert.equal(requestRejection(req({ cookie: 'fixture=valid', origin: 'dsh-app://app', 'sec-fetch-site': 'cross-site' }), webServer, connection), undefined,
  '桌面应用 Origin 可访问已认证回环通道');
assert.equal(requestRejection(req({ origin: 'dsh-app://app', 'sec-fetch-site': 'cross-site' }), webServer, connection), 401,
  '桌面应用 Origin 不得绕过登录态');
assert.equal(requestRejection(req({ cookie: 'fixture=valid', origin: 'dsh-app://other', 'sec-fetch-site': 'cross-site' }), webServer, connection), 403,
  '其他自定义协议来源仍被拒绝');
const dispose = mountControlTransport({ webServer, connection,
  wss: { handleUpgrade() { upgraded++; } },
  handleRequest(request) { handled++; assert.equal(request.url, '/status'); },
});
const response = () => ({ status: null, ended: false, writeHead(code) { this.status = code; }, end() { this.ended = true; }, setHeader() {} });
let res = response();
httpRoute.handler(req(), res);
assert.equal(res.status, 401);
assert.equal(handled, 0, '未登录不能读取状态或日志');
httpRoute.handler(req({ cookie: 'fixture=valid' }), response());
assert.equal(handled, 1);
let rejected = '';
upgradeRoute.handler(req(), { end(value) { rejected = value; } }, Buffer.alloc(0));
assert.match(rejected, /401/);
assert.equal(upgraded, 0, 'WebSocket 不能绕过登录认证');
upgradeRoute.handler(req({ cookie: 'fixture=valid' }), {}, Buffer.alloc(0));
assert.equal(upgraded, 1);
dispose(); dispose();
assert.equal(disposed, 2, '重复清理不得重复注销路由');
assert.throws(() => mountControlTransport({ webServer: { ...webServer, host: '0.0.0.0' }, connection }), /回环/);
console.log('原生认证控制通道测试通过');
