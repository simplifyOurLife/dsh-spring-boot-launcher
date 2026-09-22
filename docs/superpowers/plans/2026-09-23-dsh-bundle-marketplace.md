# DSH Bundle 与插件市场接入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将仓库改造成可通过 `dsh plugin --profile web add github:simplifyOurLife/dsh-spring-boot-launcher` 安装的单一 DSH bundle，并为 awesome-dsh-plugin 投稿做好准备。

**Architecture:** 根目录成为唯一公开发行包，通过根级 `src/index.js` 代理复用现有 Host 实现，确保 DSH 解析到根 manifest；同一根包通过 `exports["./client"]` 暴露现有 UI bundle，并用根包名注册客户端模块。现有 Host/UI 目录继续承担实现与专项测试，但不再作为两份公开安装包。

**Tech Stack:** Node.js 22.22.2、ESM、Cordis/DSH bundle manifest、YAML、原生 `node:assert`、PowerShell 7。

**Spec:** `docs/superpowers/specs/2026-09-23-dsh-bundle-marketplace-design.md`

## Global Constraints

- 对外包名固定为 `dsh-spring-boot-launcher`，首个市场准备版本固定为 `0.1.0`。
- 支持范围仍为 Windows 11、PowerShell 7、Maven Spring Boot；不得扩展宣传范围。
- 根 bundle 只插入一个 `spring-boot-launcher` Loader 条目，UI 由同一包的 `dsh.client` 提供。
- `window.__ModuleLoader__` 注册 ID 必须与根包名 `dsh-spring-boot-launcher` 完全一致；manifest 的 `dsh.client.inject` 使用官方客户端包名，Client 代码导出的 `inject` 才使用 `slots/workspaces` 服务名。
- `ws` 必须是根包运行时 `dependencies`，不能只存在于 `devDependencies`。
- 不执行 Java build 或前端 build；允许 Node 测试、manifest 校验、`npm pack --dry-run` 和 DSH 包解析检查。
- 不在本计划中创建 awesome-dsh-plugin PR、npm 发布或 GitHub Release。
- 不自动推送 GitHub；本地提交与验收完成后由用户明确授权推送。

## Review Focus

- Loader 从根代理解析包时必须命中根 manifest，而不是子目录同名 manifest；由根入口路径与动态导入测试覆盖。
- Client bundle 文件存在但注册了错误 ID 时，DSH 会在浏览器装载阶段失败；由 UI 注册 ID 测试覆盖。
- Git 源安装只携带 `files` 白名单，遗漏 Host/UI/patch 任一入口都会导致安装后失败；由 pack 清单验收覆盖。
- 开发依赖在生产安装中可能被跳过，`ws` 必须作为运行时依赖出现；由 manifest 契约测试覆盖。
- 本机 profile 迁移涉及已存在 Junction，任何目标不匹配都必须停止，不能覆盖或递归删除未知目录；由迁移前只读校验和精确 LinkType/Target 条件覆盖。

---

### Task 1: 建立根级 bundle 契约

**Files:**
- Create: `tests/bundle-contract.test.mjs`
- Create: `tests/run-all.mjs`
- Create: `src/index.js`
- Create: `cordis.patch.yml`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `dsh-spring-boot-launcher/src/index.js` 已有的 `name`、`inject`、`apply` 导出。
- Produces: 可安装根包 `dsh-spring-boot-launcher@0.1.0`、根 Host 入口 `./src/index.js`、bundle patch `./cordis.patch.yml`。

- [ ] **Step 1: 写入失败的根 bundle 契约测试**

在 `tests/bundle-contract.test.mjs` 中读取根 `package.json` 和 patch，并动态导入根入口：

```js
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
```

创建 `tests/run-all.mjs`，只导入该测试并输出总结果。先不要修改生产 manifest、入口或 patch。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node .\tests\run-all.mjs`

Expected: FAIL，首先报告根包名仍为 `dsh-spring-boot-launcher-workspace`，或者缺少 `src/index.js`/`cordis.patch.yml`；失败原因必须来自待实现契约。

- [ ] **Step 3: 实现最小根 bundle**

创建 `src/index.js`：

```js
// 根级发行入口必须位于根 package.json 下，确保 DSH 读取根 bundle/client manifest。
export * from '../dsh-spring-boot-launcher/src/index.js';
```

创建 `cordis.patch.yml`：

```yaml
- insert:
    - id: spring-boot-launcher
      name: dsh-spring-boot-launcher
```

将根 `package.json` 改为设计文档指定的名称、版本、exports、`dsh.bundle`、`dsh.client` 与运行时 `dependencies.ws`。本任务暂不增加 `files` 白名单，让 Task 3 的 pack 测试先捕获测试/本机文件被误打包的问题。根测试脚本改为：

```json
"test": "node tests/run-all.mjs && node dsh-spring-boot-launcher/tests/run-all.mjs && node dsh-spring-boot-launcher-ui/tests/run-all.mjs"
```

Run: `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`

该命令只同步锁文件，不执行 build 或安装脚本。

- [ ] **Step 4: 运行契约测试与全量测试并确认 GREEN**

Run: `node .\tests\run-all.mjs`

Expected: PASS，输出根 bundle 契约通过。

Run: `npm test`

Expected: 根契约通过；Host 19/19；UI 2/2。

- [ ] **Step 5: 提交根 bundle 契约**

```powershell
git add package.json package-lock.json src/index.js cordis.patch.yml tests/bundle-contract.test.mjs tests/run-all.mjs
git commit -m "功能：增加可安装的根级 DSH bundle"
```

### Task 2: 统一根包客户端模块身份

**Files:**
- Modify: `dsh-spring-boot-launcher-ui/tests/ui-history-smoke.mjs`
- Modify: `dsh-spring-boot-launcher-ui/tests/ui-start-state-smoke.mjs`
- Modify: `dsh-spring-boot-launcher-ui/lib/client.js`
- Modify: `dsh-spring-boot-launcher-ui/package.json`

**Interfaces:**
- Consumes: Task 1 的根 manifest 包名 `dsh-spring-boot-launcher` 和 `dsh.client.inject`。
- Produces: 注册 ID 为 `dsh-spring-boot-launcher`、导出依赖为 `slots/workspaces` 的浏览器 bundle；内部 UI package 不再独立声明 `dsh.client`。

- [ ] **Step 1: 增加失败的客户端身份断言**

在两个 UI smoke 测试捕获 `loaderEntry` 后加入：

```js
assert.equal(loaderEntry.id, 'dsh-spring-boot-launcher');
```

在根 `tests/bundle-contract.test.mjs` 中读取内部 UI manifest，固定它不能继续冒充独立 DSH Client：

```js
const uiPkg = JSON.parse(await readFile(
  new URL('dsh-spring-boot-launcher-ui/package.json', root),
  'utf8',
));
assert.equal(uiPkg.dsh, undefined);
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node .\dsh-spring-boot-launcher-ui\tests\run-all.mjs`

Expected: FAIL，实际 ID 为 `dsh-spring-boot-launcher-ui`。

Run: `node .\tests\run-all.mjs`

Expected: FAIL，内部 UI manifest 仍声明 `dsh.client`。

- [ ] **Step 3: 实现单包客户端身份**

将 `dsh-spring-boot-launcher-ui/lib/client.js` 顶部注册 ID 改为：

```js
id: "dsh-spring-boot-launcher",
```

删除 `dsh-spring-boot-launcher-ui/package.json` 的 `dsh` 字段，保留其 `private: true` 与专项测试脚本，表明它只是内部实现包。

- [ ] **Step 4: 运行 UI、根契约和全量测试并确认 GREEN**

Run: `node .\dsh-spring-boot-launcher-ui\tests\run-all.mjs`

Expected: UI 2/2 PASS。

Run: `node .\tests\run-all.mjs`

Expected: PASS。

Run: `npm test`

Expected: 根契约、Host 19/19、UI 2/2 全部通过。

- [ ] **Step 5: 提交客户端身份统一**

```powershell
git add dsh-spring-boot-launcher-ui/lib/client.js dsh-spring-boot-launcher-ui/package.json dsh-spring-boot-launcher-ui/tests/ui-history-smoke.mjs dsh-spring-boot-launcher-ui/tests/ui-start-state-smoke.mjs tests/bundle-contract.test.mjs
git commit -m "重构：统一 bundle 客户端模块身份"
```

### Task 3: 固定发行文件清单与 Git 源安装边界

**Files:**
- Create: `tests/package-contents.test.mjs`
- Modify: `tests/run-all.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 的根 manifest、全部 exports 与尚未限制的默认 pack 内容。
- Produces: 对 `npm pack --dry-run --json` 结果的自动化验收，保证 GitHub/npm 打包入口完整且不携带测试或本机状态。

- [ ] **Step 1: 写入失败的 pack 清单测试**

`tests/package-contents.test.mjs` 使用 `node:child_process.spawnSync` 在根目录执行当前平台的 `npm pack --dry-run --json`，解析首个结果的 `files[].path`，断言包含：

```js
[
  'package.json',
  'src/index.js',
  'cordis.patch.yml',
  'dsh-spring-boot-launcher/src/index.js',
  'dsh-spring-boot-launcher-ui/lib/client.js',
  'README.md',
  'LICENSE',
  'SECURITY.md',
]
```

并断言所有路径都不以这些前缀开头：

```js
['tests/', '.idea/', '.superpowers/', '.release-audit/']
```

此时根 manifest 尚未声明 `files` 白名单，测试应捕获 `tests/` 被打包，从真实缺失能力得到 RED。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node .\tests\package-contents.test.mjs`

Expected: FAIL，明确报告发行包包含 `tests/`，证明测试能捕获未限制的开发文件。

- [ ] **Step 3: 增加并校准发行白名单**

为根 `package.json` 增加以下 `files` 白名单；若测试暴露真实入口缺漏，只做最小补充。测试脚本必须使用 Windows 可用的 `npm.cmd`/`process.env.npm_execpath` 解析方式，不引入 shell 字符串拼接。

```json
[
  "src",
  "dsh-spring-boot-launcher/src",
  "dsh-spring-boot-launcher-ui/lib",
  "cordis.patch.yml",
  "README.md",
  "LICENSE",
  "SECURITY.md"
]
```

将 `tests/package-contents.test.mjs` 加入 `tests/run-all.mjs`。

- [ ] **Step 4: 运行 pack 验收与全量测试并确认 GREEN**

Run: `node .\tests\package-contents.test.mjs`

Expected: PASS，并输出 pack 文件数。

Run: `npm test`

Expected: 全部通过，且根测试不会生成 `.tgz` 文件。

- [ ] **Step 5: 提交发行清单测试**

```powershell
git add package.json tests/package-contents.test.mjs tests/run-all.mjs
git commit -m "测试：校验 DSH bundle 发行文件清单"
```

### Task 4: 更新用户安装文档

**Files:**
- Modify: `README.md`
- Modify: `dsh-spring-boot-launcher/README.md`
- Modify: `dsh-spring-boot-launcher/DESIGN.md`
- Modify: `CONTRIBUTING.md`

**Interfaces:**
- Consumes: Task 1–3 已验证的一条命令安装方式、单一 Loader 行与根包结构。
- Produces: 用户以 `dsh plugin add` 为主路径、开发者以根 link/Junction 为调试路径的准确文档。

- [ ] **Step 1: 记录文档验收 RED**

Run:

```powershell
rg -n 'dsh plugin --profile web add github:simplifyOurLife/dsh-spring-boot-launcher' README.md dsh-spring-boot-launcher\README.md
```

Expected: 无匹配，证明文档尚未提供一键安装命令。

Run:

```powershell
rg -n '两个需要同时加载的包|创建两个包|backend-launcher-ui.*insert|spring-boot-launcher-ui.*name' README.md dsh-spring-boot-launcher\README.md dsh-spring-boot-launcher\DESIGN.md
```

Expected: 至少一处仍描述双包安装或独立 UI Loader。

- [ ] **Step 2: 将一键安装改为主路径**

更新根 README：

- 快速开始首先展示 `dsh plugin --profile web add github:simplifyOurLife/dsh-spring-boot-launcher`。
- 明确完整重启 DSH、刷新页面、新建 Agent 会话。
- 将目录说明改成“一个发行 bundle、两个内部实现目录”。
- 增加卸载/更新提示时只引用 DSH CLI 已确认支持的命令；若 CLI help 没有对应命令，则不猜测。

更新 Host README：把两个 Junction + 两行 patch 降级为“源码开发方式”，并改成根目录单 Junction + 单行 patch。

更新 DESIGN 和 CONTRIBUTING：记录根代理、单包 Client 身份、bundle 契约测试与禁止再次拆成两个公开 Loader 条目的约束。

- [ ] **Step 3: 运行文档验收**

Run:

```powershell
rg -n 'dsh plugin --profile web add github:simplifyOurLife/dsh-spring-boot-launcher' README.md dsh-spring-boot-launcher\README.md
```

Expected: 两份 README 都匹配。

Run:

```powershell
rg -n 'dsh-spring-boot-launcher-ui.*name:|name:.*dsh-spring-boot-launcher-ui|两个需要同时加载的包' README.md dsh-spring-boot-launcher\README.md dsh-spring-boot-launcher\DESIGN.md
```

Expected: 无匹配。

Run: `npm test`

Expected: 全部通过。

- [ ] **Step 4: 提交安装文档**

```powershell
git add README.md CONTRIBUTING.md dsh-spring-boot-launcher/README.md dsh-spring-boot-launcher/DESIGN.md
git commit -m "文档：改为单命令安装 DSH bundle"
```

### Task 5: 迁移本机 DSH profile 并完成发布前验收

**Files:**
- Modify outside repo: `C:\Users\61706\.dsh\profiles\web\cordis.patch.yml`
- Replace Junction outside repo: `C:\Users\61706\.dsh\profiles\node_modules\dsh-spring-boot-launcher`
- Remove verified Junction outside repo: `C:\Users\61706\.dsh\profiles\node_modules\dsh-spring-boot-launcher-ui`
- GitHub metadata: add topic `dsh-plugin` if authenticated tooling is available

**Interfaces:**
- Consumes: 根包入口、单行 patch、根 Client export 和所有绿色测试。
- Produces: 本机 web profile 只加载根 bundle，GitHub 仓库具备市场要求的发现 Topic；不创建市场 PR。

- [ ] **Step 1: 只读核实迁移边界**

确认：

- 活动 patch 当前恰好包含 `spring-boot-launcher` 与 `spring-boot-launcher-ui` 两行。
- Host Junction 是 `Junction`，目标恰好为 `D:\tydic\code\plugins\dsh-spring-boot-launcher`。
- UI Junction 是 `Junction`，目标恰好为 `D:\tydic\code\plugins\dsh-spring-boot-launcher-ui`。
- 仓库根为 `D:\tydic\code\plugins`。

任一条件不满足则停止，不删除、不覆盖。

- [ ] **Step 2: 备份并迁移为单一根包**

用时间戳备份活动 `cordis.patch.yml`。创建临时名称的根 Junction并验证目标后，再替换现有 Host Junction，使：

```text
C:\Users\61706\.dsh\profiles\node_modules\dsh-spring-boot-launcher
  -> D:\tydic\code\plugins
```

活动 patch 只保留：

```yaml
- insert:
    - id: spring-boot-launcher
      name: dsh-spring-boot-launcher
```

只在 LinkType/Target 再次匹配时删除独立 UI Junction。报告备份路径；旧 Junction 仅删除链接，不删除源码。

- [ ] **Step 3: 从 web profile 验证根 Host 与 Client 解析**

在 `C:\Users\61706\.dsh\profiles\web` 执行 Node ESM 探针：

```js
const host = await import('dsh-spring-boot-launcher');
const pkg = await import('dsh-spring-boot-launcher/package.json', { with: { type: 'json' } });
console.log({
  host: host.name,
  bundle: pkg.default.dsh.bundle.patch,
  client: pkg.default.exports['./client'],
});
```

Expected: `host` 为 `spring-boot-launcher`，bundle 为 `./cordis.patch.yml`，client 指向已存在的 UI bundle。

同时读取 UI bundle 首行注册，确认 ID 为 `dsh-spring-boot-launcher`。

- [ ] **Step 4: 添加 GitHub Topic（若 gh 已登录）**

先运行只读检查：

```powershell
gh auth status
gh repo view simplifyOurLife/dsh-spring-boot-launcher --json repositoryTopics
```

认证有效时执行：

```powershell
gh repo edit simplifyOurLife/dsh-spring-boot-launcher --add-topic dsh-plugin
```

若 `gh` 不可用或未登录，不改用浏览器猜测操作；将此项作为唯一人工元数据步骤报告给用户。

- [ ] **Step 5: 最终验证和本地提交状态检查**

Run: `npm test`

Expected: 根契约与 pack 清单通过；Host 19/19；UI 2/2。

Run: `npm pack --dry-run --json`

Expected: JSON 成功，所有 exports 与 patch 均在文件清单中，无测试、本机 profile 或临时文件。

Run:

```powershell
git diff --check
git status --short --branch
git log --oneline -8
```

Expected: 无未提交修改，分支仍为 `main`；本地领先 `origin/main`，等待用户明确授权推送。

- [ ] **Step 6: 用户完成真实界面验收**

请用户完整重启 DSH，确认：

1. 启动日志不再出现 bundle/client 导入错误。
2. 侧栏出现 `Spring Boot`。
3. 面板能发现工作区 Spring Boot 项目。
4. Agent 新会话能看到五个 `spring_boot_*` 工具。

真实 DSH 验收通过后，才建议推送 GitHub，并在仓库创建满 24 小时后提交 awesome-dsh-plugin 条目。
