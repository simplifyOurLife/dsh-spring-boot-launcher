// 只提供安装命令复制；不访问本机服务，不收集访客信息。
(() => {
  const button = document.getElementById('copy-command');
  const command = document.getElementById('install-command');
  const status = document.getElementById('copy-status');
  if (!button || !command || !status) return;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('剪贴板不可用');
      await navigator.clipboard.writeText(command.textContent.trim());
      button.textContent = '已复制';
      status.textContent = '命令已复制，粘贴到终端运行即可。';
    } catch {
      button.textContent = '复制命令';
      status.textContent = '无法自动复制，请手动选中上方命令复制。';
      command.focus();
    } finally {
      button.disabled = false;
    }
  });
})();
