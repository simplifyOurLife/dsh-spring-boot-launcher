export const CONTROL_PATH = '/spring-boot-launcher';

// 不建立第二套身份系统：所有 HTTP/WS 请求必须通过 DSH 登录态检查。
// 插件仍限定本机、同源和实际监听端口，不扩大宿主 trustedHosts 的范围。
export function requestRejection(req, webServer, connection) {
  try {
    const host = String(req.headers.host || '');
    const url = new URL('http://' + host);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.host !== host ||
        Number(url.port || 80) !== webServer.port || url.pathname !== '/' || url.search || url.hash) return 403;
    const origin = req.headers.origin;
    if (origin && origin !== url.origin) return 403;
    if (req.headers['sec-fetch-site'] === 'cross-site') return 403;
    // 宿主接口缺失或抛错时拒绝访问，绝不回退到无认证模式。
    if (typeof connection?.requestRejection !== 'function') return 503;
    return connection.requestRejection(req);
  } catch { return 403; }
}

export function mountControlTransport({ webServer, connection, wss, handleRequest }) {
  if (webServer.host !== '127.0.0.1' || typeof connection?.requestRejection !== 'function') {
    throw new Error('服务面板需要支持原生认证的 DSH 回环 WebServer');
  }
  const disposers = [];
  try {
    disposers.push(webServer.register({ kind: 'prefix', path: CONTROL_PATH, handler(req, res) {
      const rejection = requestRejection(req, webServer, connection);
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'Cache-Control': 'no-store', Connection: 'close' });
        res.end();
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      req.url = req.url.slice(CONTROL_PATH.length) || '/';
      return handleRequest(req, res);
    } }));
    disposers.push(webServer.registerUpgrade({ path: CONTROL_PATH + '/ws', handler(req, socket, head) {
      const rejection = requestRejection(req, webServer, connection);
      if (rejection !== undefined) {
        socket.end(`HTTP/1.1 ${rejection} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } }));
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return () => { for (const dispose of disposers.splice(0).reverse()) dispose(); };
}
