// 新版 DSH 合并了前台/后台执行入口；旧宿主仍使用 run/start。
// 能力检测只选择接口，不在执行失败后重试，避免重复启动服务。
export async function runShell(shell, request) {
  const spec = shell.resolve(request);
  if (typeof shell.execute === 'function') {
    const execution = await shell.execute(spec);
    return execution.result();
  }
  if (typeof shell.run === 'function') return shell.run(spec);
  throw new Error('DSH Shell 缺少 execute/run 接口，请检查宿主版本');
}

export async function startShell(shell, request) {
  // 服务必须一直运行到用户停止；健康检查期限不等于服务进程期限。
  const spec = shell.resolve({ ...request, onExpiry: 'none' });
  if (typeof shell.execute === 'function') return shell.execute(spec);
  if (typeof shell.start === 'function') return shell.start(spec);
  throw new Error('DSH Shell 缺少 execute/start 接口，请检查宿主版本');
}
