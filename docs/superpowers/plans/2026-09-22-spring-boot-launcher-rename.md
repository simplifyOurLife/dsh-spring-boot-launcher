# DSH Spring Boot Launcher 完整重命名实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将尚未公开发布的 DSH Backend Launcher 完整重命名并收口为只面向 Maven Spring Boot 的 DSH Spring Boot Launcher。

**Architecture:** 保留现有 Host、UI、认证控制通道和进程管理实现，仅替换项目身份、公共工具、传输协议字段及用户可见定位。先用契约测试锁定新的 Host/UI 接口，再移动包目录并修复工作区入口，最后重写公开文档并执行全仓残留扫描。

**Tech Stack:** Node.js 22.22.2、ES Modules、Cordis/DSH 插件、原生 HTTP/WebSocket、PowerShell 7、Windows GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-09-22-spring-boot-launcher-repositioning-design.md`

## Global Constraints

- 公共项目名统一为 `DSH Spring Boot Launcher`。
- Host、UI 和工作区包名分别为 `dsh-spring-boot-launcher`、`dsh-spring-boot-launcher-ui`、`dsh-spring-boot-launcher-workspace`。
- Agent 工具只注册 `spring_boot_inspect`、`spring_boot_start`、`spring_boot_status`、`spring_boot_logs`、`spring_boot_stop`。
- 控制路径固定为 `/spring-boot-launcher`，状态集合字段固定为 `services`。
- 日志文件固定为 `logs/dsh-spring-boot-launcher.log`，浏览器存储键固定为 `dsh-spring-boot-launcher:settings`。
- 不保留旧工具、旧路由、旧存储键或旧包名的兼容别名。
- Windows 11、PowerShell 7、Maven Spring Boot 是已验证范围；Gradle 当前不支持；Linux/macOS 尚未验证且不属于当前支持范围。
- 不增加生产依赖，不重构启动算法，不执行 Java 或前端 build。
- 所有代码注释、文档、提交信息优先使用中文。

## Review Focus

- 工具注册表必须只有五个 `spring_boot_*` 工具，旧 `backend_*` 名称不能继续被 Agent 调用；由 Task 1 的公共命名测试覆盖。
- 无 `dir` 的状态查询必须返回 `{ services: [...] }`，不能遗留 `{ backends: [...] }`；由 Task 1 的状态契约断言覆盖。
- HTTP 健康响应、WS 快照和客户端连接必须同时使用新 service marker、新路径和 `services` 字段；由 Task 1、Task 2 的联调测试覆盖。
- 浏览器只能读取新存储键，旧键存在时不能被当作迁移输入；由 Task 2 的历史路径测试覆盖。
- 开源文档不得暗示通用后端、多语言 Launcher、Gradle 或跨平台支持；由 Task 4 的文档扫描测试覆盖。

---

### Task 1: 重命名 Host 公共契约与运行时标识

**Files:**
- Create: `dsh-backend-launcher/tests/public-naming.test.mjs`
- Modify: `dsh-backend-launcher/src/index.js`
- Modify: `dsh-backend-launcher/src/control-transport.js`
- Modify: `dsh-backend-launcher/src/log-storage.js`
- Modify: `dsh-backend-launcher/src/host-dependencies.js`
- Modify: `dsh-backend-launcher/tests/control-http.test.mjs`
- Modify: `dsh-backend-launcher/tests/control-transport.test.mjs`
- Modify: `dsh-backend-launcher/tests/log-storage.test.mjs`
- Modify: `dsh-backend-launcher/tests/dsh-bl-smoke-*.mjs`
- Modify: `dsh-backend-launcher/tests/support/web-host.mjs`

**Interfaces:**
- Consumes: 现有 `apply(ctx)` 插件入口、`CONTROL_PATH`、`openLogFile(dir)`、Agent 工具注册机制。
- Produces: `name === "spring-boot-launcher"`、五个 `spring_boot_*` 工具、`CONTROL_PATH === "/spring-boot-launcher"`、HTTP marker `dsh-spring-boot-launcher`、WS `{ type: "snapshot", services }`、状态查询 `{ services }`。

- [ ] **Step 1: 增加新的公共命名契约测试**

在 `public-naming.test.mjs` 中捕获 `ctx.tools.register()` 的工具定义，并加入以下核心断言：

```js
import assert from 'node:assert/strict';
import { name, description, apply } from '../src/index.js';
import { CONTROL_PATH } from '../src/control-transport.js';

const registered = [];
const ctx = {
  tools: { register(definition) { registered.push(definition); } },
  inject() {},
  on() { return () => {}; },
};
apply(ctx);

assert.equal(name, 'spring-boot-launcher');
assert.equal(CONTROL_PATH, '/spring-boot-launcher');
assert.match(description, /Spring Boot/);
assert.deepEqual(
  registered.map(({ name: toolName }) => toolName).sort(),
  ['spring_boot_inspect', 'spring_boot_logs', 'spring_boot_start', 'spring_boot_status', 'spring_boot_stop'],
);
assert.ok(registered.every(({ name: toolName }) => !toolName.startsWith('backend_')));
```

如果 `apply()` 需要测试宿主依赖，沿用 `tests/support/register.mjs` 的加载 hook，不在生产代码中增加测试开关。

- [ ] **Step 2: 将现有联调断言切换到新协议并确认失败**

在 HTTP/WS、transport、日志和 smoke 测试中写入这些期望：

```js
assert.equal(CONTROL_PATH, '/spring-boot-launcher');
assert.equal((await res.json()).service, 'dsh-spring-boot-launcher');
assert.deepEqual(snapshot.services, {});
assert.ok(opened.path.endsWith('dsh-spring-boot-launcher.log'));
assert.deepEqual(Object.keys(byName).sort(), [
  'spring_boot_inspect', 'spring_boot_logs', 'spring_boot_start',
  'spring_boot_status', 'spring_boot_stop',
]);
```

把 smoke 测试调用从 `byName.backend_start` 等替换为对应的 `byName.spring_boot_start`；无目录状态查询断言 `result.services`，不接受 `result.backends`。

- [ ] **Step 3: 运行 Host 测试并记录预期失败**

Run:

```powershell
node --import .\dsh-backend-launcher\tests\support\register.mjs .\dsh-backend-launcher\tests\public-naming.test.mjs
node --import .\dsh-backend-launcher\tests\support\register.mjs .\dsh-backend-launcher\tests\control-http.test.mjs
node --import .\dsh-backend-launcher\tests\support\register.mjs .\dsh-backend-launcher\tests\log-storage.test.mjs
```

Expected: 分别因旧插件名、旧 `/backend-launcher` 路径或旧日志文件名失败。

- [ ] **Step 4: 实现 Host 最小重命名**

在生产代码中完成以下一致替换：

```js
const SERVICE_MARKER = 'dsh-spring-boot-launcher';
const name = 'spring-boot-launcher';
export const CONTROL_PATH = '/spring-boot-launcher';
const logPath = join(logsDir, 'dsh-spring-boot-launcher.log');
```

工具名切换为五个 `spring_boot_*` 名称，相关提示文本同步引用新工具。`ControlServer.snapshotPayload()` 返回 `services` 语义的数据，并让 HTTP `/status`、WS snapshot 以及无目录的 `spring_boot_status` 都使用 `services` 字段。内部 `backends`、`backend`、`Backend` 标识改成 `services`、`service`、`SpringBootService`；错误与日志前缀统一为 `[spring-boot-launcher]`。

- [ ] **Step 5: 运行 Host 全套测试**

Run:

```powershell
node .\dsh-backend-launcher\tests\run-all.mjs
```

Expected: 所有 Host 套件通过；输出中的工具、路由、marker 和日志路径均为新名称。

- [ ] **Step 6: 提交 Host 契约变更**

```powershell
git add dsh-backend-launcher/src dsh-backend-launcher/tests
git commit -m "重构：统一 Spring Boot Host 公共标识"
```

### Task 2: 重命名 UI 状态模型、连接协议与界面名称

**Files:**
- Modify: `dsh-backend-launcher-ui/lib/client.js`
- Modify: `dsh-backend-launcher-ui/lib/index.js`
- Modify: `dsh-backend-launcher-ui/tests/ui-history-smoke.mjs`
- Modify: `dsh-backend-launcher-ui/tests/ui-start-state-smoke.mjs`

**Interfaces:**
- Consumes: Task 1 的 `/spring-boot-launcher`、`dsh-spring-boot-launcher` 和 WS `services` 快照。
- Produces: UI module id `dsh-spring-boot-launcher-ui`、插件名 `spring-boot-launcher-ui`、存储键 `dsh-spring-boot-launcher:settings`、状态对象 `services`、入口 `Spring Boot`、面板标题 `Spring Boot Services`。

- [ ] **Step 1: 把 UI 测试切换到新契约**

将两个测试中的模拟响应和断言改为：

```js
assert.ok(value.startsWith('/spring-boot-launcher/'));
return { json: async () => ({ service: 'dsh-spring-boot-launcher' }) };
assert.equal(url, 'ws://127.0.0.1:3000/spring-boot-launcher/ws');
```

历史路径测试同时放入新旧两个键，并让内容不同：

```js
const storage = new Map([
  ['dsh-backend-launcher:settings', JSON.stringify({ recentDirs: ['D:\\old\\must-not-load'] })],
  ['dsh-spring-boot-launcher:settings', JSON.stringify({ recentDirs })],
]);
```

断言面板出现 `recentDirs` 中的路径，不出现 `must-not-load`；断言侧栏文本包含 `Spring Boot`、面板标题包含 `Spring Boot Services`。

- [ ] **Step 2: 运行 UI 测试并确认失败**

Run:

```powershell
node .\dsh-backend-launcher-ui\tests\run-all.mjs
```

Expected: 因旧控制路径、旧 service marker、旧存储键或旧界面标题失败。

- [ ] **Step 3: 实现 UI 最小重命名**

在 `client.js` 中设置：

```js
id: 'dsh-spring-boot-launcher-ui'
var CONTROL_PATH = '/spring-boot-launcher';
var LS_KEY = 'dsh-spring-boot-launcher:settings';
```

状态模型从 `backends` 全部改为 `services`，WS snapshot 读取 `msg.services || {}`。函数、组件、属性、`data-*`、样式 ID 和 CSS 类前缀不保留本项目的 `backend` 缩写；例如 `BackendServicesEntry` 改为 `SpringBootServicesEntry`、`BackendRow` 改为 `ServiceRow`。入口显示 `Spring Boot`，主标题显示 `Spring Boot Services`，手动路径占位符使用 `D:\path\to\spring-boot\project`。

`lib/index.js` 导出：

```js
export const name = 'spring-boot-launcher-ui';
```

- [ ] **Step 4: 运行 UI 全套测试**

Run:

```powershell
node .\dsh-backend-launcher-ui\tests\run-all.mjs
```

Expected: 两个 UI smoke 套件通过，旧存储键内容未进入界面。

- [ ] **Step 5: 提交 UI 变更**

```powershell
git add dsh-backend-launcher-ui/lib dsh-backend-launcher-ui/tests
git commit -m "重构：统一 Spring Boot 服务面板标识"
```

### Task 3: 重命名包、目录、测试文件与工作区入口

**Files:**
- Rename: `dsh-backend-launcher/` → `dsh-spring-boot-launcher/`
- Rename: `dsh-backend-launcher-ui/` → `dsh-spring-boot-launcher-ui/`
- Rename: `dsh-spring-boot-launcher/tests/dsh-bl-smoke-*.mjs` → `dsh-spring-boot-launcher/tests/spring-boot-smoke-*.mjs`
- Rename: `docs/images/backend-services-panel.png` → `docs/images/spring-boot-services-panel.png`
- Modify: `dsh-spring-boot-launcher/package.json`
- Modify: `dsh-spring-boot-launcher-ui/package.json`
- Modify: `dsh-spring-boot-launcher/tests/run-all.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Task 1、Task 2 已通过的新 Host/UI 接口。
- Produces: 新的物理包路径和 npm 包名；根命令 `npm test` 只引用新目录；测试 runner 发现 `spring-boot-smoke-*`。

- [ ] **Step 1: 先更新工作区入口并确认其因旧目录结构失败**

将根 `package.json` 改为：

```json
{
  "name": "dsh-spring-boot-launcher-workspace",
  "scripts": {
    "test": "node dsh-spring-boot-launcher/tests/run-all.mjs && node dsh-spring-boot-launcher-ui/tests/run-all.mjs"
  }
}
```

同步更新 `package-lock.json` 顶层两个 workspace 名称。运行：

```powershell
npm test
```

Expected: Node 报告找不到 `dsh-spring-boot-launcher/tests/run-all.mjs`，证明根入口已经要求新目录。

- [ ] **Step 2: 校验目标路径并执行 Windows 原生移动**

先用 `Resolve-Path` 确认两个源目录和图片都位于 `D:\tydic\code\plugins`，再确认三个目标路径不存在。使用 PowerShell `Move-Item -LiteralPath` 分别移动两个目录和图片；不要使用跨 shell 的字符串拼接或递归删除命令。

```powershell
Move-Item -LiteralPath '.\dsh-backend-launcher' -Destination '.\dsh-spring-boot-launcher'
Move-Item -LiteralPath '.\dsh-backend-launcher-ui' -Destination '.\dsh-spring-boot-launcher-ui'
Move-Item -LiteralPath '.\docs\images\backend-services-panel.png' -Destination '.\docs\images\spring-boot-services-panel.png'
```

- [ ] **Step 3: 重命名 smoke 测试并更新 runner**

把 `dsh-bl-smoke-*.mjs` 逐个改为 `spring-boot-smoke-*.mjs`。将 runner 的发现条件改为：

```js
.filter((file) => (file.startsWith('spring-boot-smoke-') || file.endsWith('.test.mjs')) && file.endsWith('.mjs'))
```

更新测试临时目录前缀为 `dsh-spring-boot-suite-`，并修复源码、测试和支持文件中因目录变化而失效的相对路径或字面量。

- [ ] **Step 4: 更新包元数据和忽略规则**

Host/UI `package.json` 的 `name` 分别设为 `dsh-spring-boot-launcher` 和 `dsh-spring-boot-launcher-ui`。`.gitignore` 删除旧 `/dsh-backend-launcher/DESIGN.md` 与旧截图目录规则；新的公开 `dsh-spring-boot-launcher/DESIGN.md` 不忽略。保留 `docs/superpowers/`、依赖、日志和本地审计忽略规则。

- [ ] **Step 5: 运行根测试验证新路径**

Run:

```powershell
npm test
```

Expected: Host 与 UI 全部测试通过，命令输出不引用旧包目录。

- [ ] **Step 6: 提交目录和包结构变更**

```powershell
git add .gitignore package.json package-lock.json docs/images dsh-spring-boot-launcher dsh-spring-boot-launcher-ui
git commit -m "重构：重命名 Spring Boot 启动器包结构"
```

### Task 4: 重写开源文档与项目定位

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/release-readiness.md`
- Replace: `dsh-spring-boot-launcher/README.md`
- Replace: `dsh-spring-boot-launcher/DESIGN.md`
- Modify: `dsh-spring-boot-launcher/CONTRIBUTING.md`
- Create: `tests/public-docs.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 3 的最终目录、包名、工具名、路由和图片路径。
- Produces: 与实际能力一致的中文开源首页、安装说明、安全边界、贡献指南、设计说明和机器可执行的文档定位检查。

- [ ] **Step 1: 增加公开文档定位测试**

创建根目录 `tests/public-docs.test.mjs`，读取公开 Markdown、package 元数据与工作流并断言：

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const paths = [
  'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/release-readiness.md',
  'dsh-spring-boot-launcher/README.md',
  'dsh-spring-boot-launcher/DESIGN.md',
  'dsh-spring-boot-launcher/CONTRIBUTING.md',
];
const publicText = paths.map((path) => readFileSync(path, 'utf8')).join('\n');
for (const forbidden of [
  'dsh-backend-launcher', '/backend-launcher', 'backend_inspect',
  'Backend Services', '多语言 Launcher', '通用后端启动器',
]) assert.ok(!publicText.includes(forbidden), `公开文档残留旧定位：${forbidden}`);
assert.match(publicText, /DSH Spring Boot Launcher/);
assert.match(publicText, /Windows 11/);
assert.match(publicText, /Linux.*macOS|macOS.*Linux/s);
```

在根 `package.json` 的测试命令末尾追加 `node tests/public-docs.test.mjs`。

- [ ] **Step 2: 运行文档测试并确认失败**

Run:

```powershell
node .\tests\public-docs.test.mjs
```

Expected: 因 README、安全文档或设计文档仍包含旧名称和旧定位失败。

- [ ] **Step 3: 重写 README 与设计说明**

根 README 和包内 README 必须包含：

- 名称 `DSH Spring Boot Launcher` 和 Spring Boot 徽章。
- Maven Spring Boot 项目发现、Profile、JDK、运行模式、进程、实时日志功能。
- `spring_boot_*` 工具表、新包安装示例、新控制路径和新日志文件名。
- Windows 11 已验证；Gradle 不支持；Linux/macOS 未验证且不在当前支持范围。
- 新截图路径 `docs/images/spring-boot-services-panel.png`。
- 不出现其他服务类型 Launcher 的扩展承诺。

用一份紧凑、现状导向的 `DESIGN.md` 替换原多语言框架愿景，只描述 Host/UI、Agent/GUI 共用进程状态、认证 HTTP/WS、运行模式决策、日志与安全边界。

- [ ] **Step 4: 更新安全、贡献与发布说明**

`SECURITY.md` 使用 `/spring-boot-launcher` 和新日志文件名。两份贡献指南要求复现材料聚焦脱敏 `pom.xml`、JDK、Profile、入口类和 `modeReasons`。发布检查单使用新包名并明确只有 Windows CI/人工验收；不把未验证平台描述为可用。

- [ ] **Step 5: 运行文档测试和根测试**

Run:

```powershell
node .\tests\public-docs.test.mjs
npm test
```

Expected: 文档定位检查通过，Host/UI 回归套件继续通过。

- [ ] **Step 6: 提交公开文档**

```powershell
git add README.md SECURITY.md CONTRIBUTING.md docs/release-readiness.md tests package.json dsh-spring-boot-launcher/README.md dsh-spring-boot-launcher/DESIGN.md dsh-spring-boot-launcher/CONTRIBUTING.md
git commit -m "文档：聚焦 Spring Boot 启动器开源定位"
```

### Task 5: 执行全仓残留扫描与开源验收

**Files:**
- Modify only if checks expose a missed reference in files owned by Tasks 1–4.

**Interfaces:**
- Consumes: 最终源码、测试、包结构与公开文档。
- Produces: 无活动旧标识、全套测试通过、可交给用户做真实 DSH 验收的工作树。

- [ ] **Step 1: 扫描活动旧标识**

Run:

```powershell
rg -n -i 'dsh-backend-launcher|backend-launcher|backend_(inspect|start|status|logs|stop)|Backend Services|\bBackends\b|\bbackends\b|多语言 Launcher|通用后端启动器' -g '!node_modules/**' -g '!docs/superpowers/**' .
```

Expected: 无输出。若历史实施记录仍需保留，必须放在 `docs/superpowers/` 下且不被公开 README 链接；活动源码、测试、包元数据与公开文档不得命中。

- [ ] **Step 2: 扫描新标识覆盖范围**

Run:

```powershell
rg -n 'dsh-spring-boot-launcher|spring-boot-launcher|spring_boot_(inspect|start|status|logs|stop)|Spring Boot Services|services' -g '!node_modules/**' .
```

Expected: Host、UI、测试、包元数据、README、安全和贡献文档均有对应新标识；不是只改文案。

- [ ] **Step 3: 验证引用文件存在**

Run:

```powershell
@(
  '.\dsh-spring-boot-launcher\src\index.js',
  '.\dsh-spring-boot-launcher-ui\lib\client.js',
  '.\docs\images\spring-boot-services-panel.png'
) | ForEach-Object { if (-not (Test-Path -LiteralPath $_)) { throw "缺少文件：$_" } }
```

Expected: 无异常。

- [ ] **Step 4: 执行最终测试**

Run:

```powershell
npm test
```

Expected: Host、UI 和公开文档测试全部通过。不运行 `npm run build`、Maven build 或 Java build。

- [ ] **Step 5: 检查 Git 变更边界**

Run:

```powershell
git status --short
git diff --check
git diff --stat
```

Expected: 无空白错误；变更仅涉及重命名、契约、测试、包结构和公开文档。`.idea/`、`node_modules/`、日志、本地审计材料不进入提交。

- [ ] **Step 6: 提交遗漏修正（仅在有修正时）**

```powershell
git add README.md SECURITY.md CONTRIBUTING.md docs package.json package-lock.json tests dsh-spring-boot-launcher dsh-spring-boot-launcher-ui .github .gitignore
git commit -m "测试：完成 Spring Boot 启动器开源验收"
```

- [ ] **Step 7: 交给用户做真实环境验收**

向用户列出不由自动测试覆盖的手工验证：重新连接两个新包、更新 `cordis.patch.yml`、重启 DSH、确认侧栏 `Spring Boot`、用 `spring_boot_inspect` 检查真实 Maven 项目、启动与停止一个可信服务、确认日志写入 `logs/dsh-spring-boot-launcher.log`。

