import {mkdirSync,openSync,appendFileSync,closeSync,existsSync,rmSync,renameSync,fstatSync} from 'node:fs';
import {join} from 'node:path';
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const MAX_LOG_BUFFER = 512 * 1024;
function openLogFile(dir) {
  const logsDir = join(dir, "logs");
  const logPath = join(logsDir, "dsh-spring-boot-launcher.log");
  try {
    mkdirSync(logsDir, { recursive: true });
    return { fd: openSync(logPath, "a"), path: logPath };
  } catch {
    return { fd: null, path: logPath };
  }
}

function closeLog(entry) {
  if (entry.logFd !== null && entry.logFd !== undefined) {
    try {
      closeSync(entry.logFd);
    } catch {
      /* already closed */
    }
  }
  entry.logFd = null;
}

function appendLog(entry, delta) {
  entry.logBuffer += delta;
  if (entry.logBuffer.length > MAX_LOG_BUFFER) {
    entry.logBuffer = entry.logBuffer.slice(-MAX_LOG_BUFFER);
  }
  if (entry.logFd !== null && entry.logFd !== undefined) {
    try {
      const clean = delta.replace(ANSI_RE, "");
      // 限制引擎日志为 10 MiB × 4 份；仅轮转本插件拥有的固定文件名。
      const logPath = entry.handle.logPath;
      if (fstatSync(entry.logFd).size + Buffer.byteLength(clean) > 10 * 1024 * 1024) {
        closeLog(entry);
        for (let index = 3; index >= 1; index--) {
          const target = `${logPath}.${index}`;
          const source = index === 1 ? logPath : `${logPath}.${index - 1}`;
          if (existsSync(target)) rmSync(target);
          if (existsSync(source)) renameSync(source, target);
        }
        entry.logFd = openSync(logPath, 'a');
      }
      // 按字节限制单次写入，中文日志不能按字符数估算磁盘占用。
      const bytes = Buffer.from(clean);
      appendFileSync(entry.logFd, bytes.subarray(Math.max(0, bytes.length - 10 * 1024 * 1024)));
    } catch {
      closeLog(entry); // disk full / file locked — stop trying, keep streaming
    }
  }
}
export {openLogFile,closeLog,appendLog};
