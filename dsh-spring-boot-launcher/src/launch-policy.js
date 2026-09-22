// 当前命令经过 PowerShell 与 cmd 两层解析，拒绝可触发插值/命令串联的字符。
// 这只限制启动器参数，不把不可信 Maven 工程变成可信代码。
export function assertSafeCommandValue(value, label) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f"&|<>^%!`$]/.test(value)) {
    throw new Error(`${label} 包含当前启动器不支持的命令字符`);
  }
  return value;
}

export function validateLaunchArgs(args) {
  try {
    if (!args || typeof args !== 'object' || typeof args.dir !== 'string' || !args.dir.trim()) throw new Error('dir 必须是非空目录');
    for (const field of ['dir','jarPath','profile','jvmArgs']) {
      if (args[field] !== undefined) assertSafeCommandValue(args[field], field);
    }
    if (args.profile && !/^[\w.,-]+$/.test(args.profile)) throw new Error('profile 只支持字母、数字、下划线、点、逗号与横线');
    if (args.port !== undefined && (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535)) throw new Error('port 必须为 1–65535 的整数');
    if (args.mode !== undefined && !['auto','jar-run','direct-classpath','dev-run','dev-run-classpath','reactor-run'].includes(args.mode)) throw new Error('未知启动模式');
    for (const field of ['build','noBuild','mvnOffline','detach']) {
      if (args[field] !== undefined && typeof args[field] !== 'boolean') throw new Error(`${field} 必须为布尔值`);
    }
    // 每一项都必须为 JVM 选项，避免插入主类、@参数文件或改变启动入口。
    for (const token of (args.jvmArgs || '').trim().split(/\s+/).filter(Boolean)) {
      if (!/^-(?:D[^\s=]+(?:=.*)?|X[^\s]+|ea|da|esa|dsa)$/.test(token)) throw new Error('jvmArgs 仅支持无空格的 -D、-X 和断言选项');
    }
    return null;
  } catch (error) {
    return {code:'INVALID_ARGUMENT',message:error.message};
  }
}

export function javaMajor(version) {
  const match = String(version || '').match(/(?:version\s+"?|(?:openjdk|java)\s+)(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  return Number(match[1]) === 1 ? Number(match[2]) || null : Number(match[1]);
}

// 精确版本优先精确匹配；8+/17+ 等最低版本保留候选优先级（JAVA_HOME 优先）。
export function selectJdk(candidates, required = '8+') {
  const match = String(required).match(/^(?:1\.)?(\d+)(\+)?$/);
  if (!match) return null;
  const major = Number(match[1]);
  return candidates.find(candidate => {
    const actual = javaMajor(candidate.detectedVersion);
    return actual !== null && (match[2] ? actual >= major : actual === major);
  }) || null;
}
