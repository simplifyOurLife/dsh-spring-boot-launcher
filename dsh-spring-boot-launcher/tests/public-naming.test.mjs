// 公共命名契约：防止首次开源前仍暴露已经废弃的旧定位标识。
import assert from 'node:assert/strict';
import { apply, name } from '../src/index.js';
import { CONTROL_PATH } from '../src/control-transport.js';

const registered = [];
const ctx = {
  tools: { register(definition) { registered.push(definition); } },
  inject() {},
  on() { return () => {}; },
};

apply(ctx);

const toolNames = registered.map((definition) => definition.name).sort();
assert.equal(name, 'spring-boot-launcher');
assert.equal(CONTROL_PATH, '/spring-boot-launcher');
assert.deepEqual(toolNames, [
  'spring_boot_inspect',
  'spring_boot_logs',
  'spring_boot_start',
  'spring_boot_status',
  'spring_boot_stop',
]);
assert.ok(registered.every((definition) => /Spring Boot/.test(definition.description)));

const status = registered.find((definition) => definition.name === 'spring_boot_status');
assert.deepEqual(await status.execute({}), { services: [] });

console.log('Spring Boot Launcher 公共命名契约测试通过');
