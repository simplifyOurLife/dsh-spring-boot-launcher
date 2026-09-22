// 仅测试进程加载此 hook，生产代码没有绕过宿主的开关。
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);
