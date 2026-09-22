import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

// JAVA_HOME 优先，其次 PATH，最后约定安装目录；候选仍由实际 -version 校验。
export function detectJdkCandidates(env = process.env) {
  const candidates = [];
  const seen = new Set();
  const variable = (name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
  const add = (path, source) => {
    if (!path) return;
    try {
      const home = resolve(path);
      if (!existsSync(join(home, 'bin', 'java.exe'))) return;
      const key = realpathSync(home).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ path: home, source });
    } catch { /* 不可读的候选不影响后续发现 */ }
  };
  const unquote = (value) => String(value || '').trim().replace(/^"(.*)"$/, '$1');
  add(unquote(variable('JAVA_HOME')), 'JAVA_HOME');
  for (const item of String(variable('PATH') || '').split(';')) {
    const directory = unquote(item);
    if (!directory) continue; // 空项不得隐式搜索工作目录。
    const java = join(directory, 'java.exe');
    if (!existsSync(java)) continue;
    try {
      // 兼容 javapath 等符号链接，但不把 shim 所在目录伪装成 JDK。
      add(dirname(dirname(realpathSync(java))), 'PATH');
    } catch { /* 跳过断开的链接 */ }
  }
  const roots = [
    'C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Amazon Corretto',
    'C:\\Program Files\\Zulu', 'C:\\Program Files\\BellSoft',
  ];
  if (variable('USERPROFILE')) roots.push(join(variable('USERPROFILE'), '.jdks'));
  for (const root of roots) {
    try {
      for (const entry of readdirSync(root)) add(join(root, entry), 'conventional');
    } catch { /* 跳过不存在或不可读的目录 */ }
  }
  return candidates;
}
