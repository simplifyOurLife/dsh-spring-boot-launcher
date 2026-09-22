import assert from 'node:assert/strict';
import { validateLaunchArgs, javaMajor, selectJdk } from '../src/launch-policy.js';

assert.equal(validateLaunchArgs({dir:'D:\\work\\demo',profile:'dev',jvmArgs:'-Xmx2g -Dfile.encoding=UTF-8',port:8080}), null);
for (const value of ['dev & whoami', 'dev$(whoami)', 'dev%PATH%', 'dev`whoami', 'dev\nwhoami', 'dev"']) {
  assert.equal(validateLaunchArgs({dir:'D:\\work\\demo',profile:value})?.code, 'INVALID_ARGUMENT');
}
for (const port of [0,65536,-1,1.5,'8080']) assert.ok(validateLaunchArgs({dir:'D:\\work',port}));
assert.ok(validateLaunchArgs({dir:'D:\\work',jvmArgs:'-Xmx2g MainClass'}));
assert.ok(validateLaunchArgs({dir:'D:\\work',mode:'unknown'}));
assert.equal(javaMajor('java version "1.8.0_421"'),8);
assert.equal(javaMajor('openjdk version "17.0.12"'),17);
assert.equal(javaMajor('openjdk 21.0.2 2024-01-16'),21);
assert.equal(javaMajor(''),null);
const candidates = [{path:'java8',detectedVersion:'java version "1.8.0_421"'}, {path:'java21',detectedVersion:'openjdk version "21.0.2"'}, {path:'java17',detectedVersion:'openjdk version "17.0.12"'}];
assert.equal(selectJdk(candidates,'17+').path,'java21');
assert.equal(selectJdk(candidates,'17').path,'java17');
assert.equal(selectJdk(candidates,'25+'),null);
assert.equal(selectJdk([{path:'unknown'}],'8+'),null);
console.log('启动参数与 JDK 选择测试通过');
