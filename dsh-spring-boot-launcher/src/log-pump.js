// 每个进程只有一个 pump；调用者等待 promise 才能关闭日志句柄。
export async function pumpProcess(proc, {append, onEnd, signal, interval = 300, drainInterval = 150}) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const read = () => {
    const output = proc.readOutput();
    if (output.delta) append(output.delta);
    if (output.lossy) append('\n[日志缓冲溢出，部分输出不可用]\n');
    return output.delta;
  };
  while (proc.status === 'running' && !signal?.aborted) {
    read();
    await pause(interval);
  }
  if (signal?.aborted && proc.status === 'running') return;
  // 新版 kill() 先改变 status，再异步完成 provider 退出。
  // done 才是输出已收齐的边界；旧测试或旧句柄未提供时仍兼容。
  if (proc.done) await proc.done;
  // 连续两次空读后结束，最后一段 shutdown 输出可能晚于状态切换。
  let empty = 0;
  for (let i = 0; i < 8 && empty < 2; i++) {
    empty = read() ? 0 : empty + 1;
    await pause(drainInterval);
  }
  await onEnd(proc.status);
}
