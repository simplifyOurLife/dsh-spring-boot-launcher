import { createServer } from 'node:http';
// 使用真实 HTTP socket，宿主认证以固定测试 cookie 代替。
export async function createWebHost() {
  let route, upgrade;
  const server = createServer((req, res) => {
    if (route && req.url.startsWith(route.path + '/')) return route.handler(req, res);
    res.writeHead(404); res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (upgrade && req.url === upgrade.path) upgrade.handler(req, socket, head);
    else socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    webServer: { host: '127.0.0.1', port,
      register(value) { route = value; return () => { route = null; }; },
      registerUpgrade(value) { upgrade = value; return () => { upgrade = null; }; },
    },
    connection: { requestRejection(req) { return req.headers.cookie === 'fixture=valid' ? undefined : 401; } },
    fetch(path, options = {}) {
      return fetch(`http://127.0.0.1:${port}/spring-boot-launcher${path}`, { ...options,
        headers: { cookie: 'fixture=valid', ...options.headers } });
    },
    close() { server.closeAllConnections(); server.close(); },
  };
}
