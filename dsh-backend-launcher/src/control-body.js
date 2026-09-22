// 控制请求只传启动参数：按字节限流，并限制完整请求体的读取时间。
export function readBody(req, { maxBytes = 64 * 1024, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    let settled = false;
    const fail = (statusCode, message) => finish(Object.assign(new Error(message), { statusCode }));
    const cleanup = () => {
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted);
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        chunks.length = 0;
        // 暂停继续读取；调用方发送错误响应后关闭连接。
        req.pause?.();
        reject(error);
      } else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > maxBytes) return fail(413, '请求体超过允许大小');
      chunks.push(data);
    };
    const onEnd = () => finish();
    const onAborted = () => fail(400, '请求体传输中断');
    const onClose = () => { if (!settled) onAborted(); };
    const onError = () => fail(400, '请求体读取失败');
    const timer = setTimeout(() => fail(408, '请求体读取超时'), timeoutMs);
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
    req.once('close', onClose);
    const length = req.headers?.['content-length'];
    if (length !== undefined && (!/^\d+$/.test(String(length)) || !Number.isSafeInteger(Number(length)))) {
      fail(400, '无效的 Content-Length');
    } else if (Number(length) > maxBytes) {
      fail(413, '请求体超过允许大小');
    }
  });
}
