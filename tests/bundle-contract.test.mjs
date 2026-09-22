import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

assert.equal(pkg.name, 'dsh-spring-boot-launcher');
assert.equal(pkg.version, '0.1.0');
assert.notEqual(pkg.private, true);
assert.equal(pkg.main, './src/index.js');
assert.equal(pkg.exports['.'], './src/index.js');
assert.equal(pkg.exports['./client'], './dsh-spring-boot-launcher-ui/lib/client.js');
assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml');
assert.equal(pkg.exports['./package.json'], './package.json');
assert.deepEqual(pkg.dsh.bundle, { patch: './cordis.patch.yml' });
assert.deepEqual(pkg.dsh.client, {
  platform: 'web',
  inject: [
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-workspace',
  ],
});
assert.equal(pkg.dependencies.ws, '8.21.3');
assert.equal(pkg.devDependencies?.ws, undefined);

const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8');
assert.match(patch, /id:\s*spring-boot-launcher/);
assert.match(patch, /name:\s*dsh-spring-boot-launcher/);
assert.equal((patch.match(/\bid:/g) || []).length, 1);

const entry = await import('../src/index.js');
assert.equal(entry.name, 'spring-boot-launcher');
assert.deepEqual(entry.inject, ['tools', 'shell']);
assert.equal(typeof entry.apply, 'function');

console.log('根级 DSH bundle 契约测试通过');
