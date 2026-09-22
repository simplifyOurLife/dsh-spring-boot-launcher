# DSH Bundle 与插件市场接入设计

## 背景

仓库当前以两个本地开发包运行：`dsh-spring-boot-launcher` 提供 Host，`dsh-spring-boot-launcher-ui` 提供浏览器界面。安装依赖手工创建两个 Junction，并在用户 profile 的 `cordis.patch.yml` 中插入两行。该结构可以用于本地开发，但仓库根目录没有 `dsh.bundle`，无法通过 `dsh plugin --profile web add github:simplifyOurLife/dsh-spring-boot-launcher` 安装，也不满足 awesome-dsh-plugin 的自动检查。

## 目标

- 将仓库根目录变成唯一公开安装包 `dsh-spring-boot-launcher`。
- 支持从 GitHub 源码执行一条命令安装，无需用户手工创建 Junction 或编辑 profile patch。
- 一个 Loader 条目同时提供 Host 与 Web Client。
- 保留现有 Host/UI 实现目录，避免与安装能力无关的大规模源码搬迁。
- 保持 Windows 11、PowerShell 7、Maven Spring Boot 的真实支持边界。
- 为后续向 awesome-dsh-plugin 的 `dev` 分类提交单条 YAML 做好准备。

## 非目标

- 本轮不发布 npm 包。
- 本轮不声称支持 Gradle、Linux、macOS 或非 Spring Boot 服务。
- 本轮不改变启动策略、进程管理、控制通道或 UI 功能。
- 本轮不自动向 awesome-dsh-plugin 创建 PR；仓库满 24 小时且安装验收通过后再投稿。

## 方案选择

### 采用：根级发行包 + 根级 Host 代理

根 `package.json` 成为对外 manifest，并新增根级 `src/index.js`，仅重新导出现有 Host 实现。根 manifest 的 `main` 和 `exports["."]` 指向该代理，`exports["./client"]` 指向现有 UI bundle。

必须使用根级代理，不能让根 `main` 直接指向 `dsh-spring-boot-launcher/src/index.js`。DSH 客户端加载器会从 Loader 实际入口向上寻找最近的同名 `package.json`；直接指向子目录会命中子包 manifest，使根级 `dsh.client` 不可见。根级代理让 Loader 先解析根 manifest，同时继续复用子目录实现。

### 未采用：继续发布两个独立包

这要求两个包分别发布到 npm，或再维护一个依赖它们的聚合包；首次开源阶段会增加版本、发布和依赖同步成本。

### 未采用：把源码整体搬入 `packages/`

该方式符合传统 monorepo，但会产生大量路径和历史噪音，不能为当前一键安装目标带来额外能力。

## 根级包契约

根 `package.json` 调整为：

- `name`: `dsh-spring-boot-launcher`
- `version`: `0.1.0`
- 删除 `private: true`
- `main` 与 `exports["."]`: `./src/index.js`
- `exports["./client"]`: `./dsh-spring-boot-launcher-ui/lib/client.js`
- `exports["./cordis.patch.yml"]`: `./cordis.patch.yml`
- `exports["./package.json"]`: `./package.json`
- `dsh.bundle.patch`: `./cordis.patch.yml`
- `dsh.client.platform`: `web`
- `dsh.client.inject`: `["slots", "workspaces"]`
- `ws` 从 `devDependencies` 移到 `dependencies`，因为 Host 在运行时导入它。
- `files` 只包含根入口、Host 源码、UI bundle、patch、README、LICENSE、SECURITY 和必要文档；测试、截图源文件和开发台账不进入安装包。

子目录中的两个 `package.json` 保留为内部测试入口，但不再作为公开安装方式。所有公开文档以根级单包为准。

## Bundle patch 与客户端身份

根 `cordis.patch.yml` 只插入一个 Loader 条目：

```yaml
- insert:
    - id: spring-boot-launcher
      name: dsh-spring-boot-launcher
```

根包同时声明 `dsh.client`，因此不再插入独立 UI Loader 行。UI bundle 中 `window.__ModuleLoader__.load({ id })` 必须注册 `dsh-spring-boot-launcher`；DSH 图表以 manifest 的包名作为客户端模块 ID，二者不一致会报“bundle loaded without registering”错误。

## 安装与本地开发

面向用户的主安装方式：

```powershell
dsh plugin --profile web add github:simplifyOurLife/dsh-spring-boot-launcher
```

开发者仍可使用 link/Junction，但只连接仓库根目录为 `dsh-spring-boot-launcher`，不再单独加载 UI 包，也不再手工维护两行 patch。现有本机 profile 在仓库改造完成后迁移为单一根 Junction 和单一 Loader 行；迁移前备份配置，只删除经过目标校验的旧 Junction。

## 测试与验收

新增安装契约测试，至少验证：

1. 根 manifest 具有正确的 `dsh.bundle`、`dsh.client`、exports、版本和运行时依赖。
2. `cordis.patch.yml` 只插入 `spring-boot-launcher`，名称与根包一致。
3. 根 Host 入口可导入，并导出 `name`、`inject`、`apply`。
4. UI bundle 注册 ID 等于根包名，且导出的 `inject` 仍包含 `slots` 与 `workspaces`。
5. `npm pack --dry-run --json` 的文件清单包含所有入口，不包含测试和本地配置。
6. 现有 Host 19 个套件和 UI 2 个套件继续通过。
7. 从 DSH web profile 解析根包时，Host 与 Client 都能被发现；最终由用户完整重启 DSH 做界面验收。

根据仓库规则，不自动执行 Java 或前端 build。Node 测试、打包清单检查和 DSH 包解析检查可以自动执行。

## 文档与市场准备

README 将一键安装设为主路径，把 Junction 标记为开发安装；兼容性表继续明确仅验证 Windows/Maven Spring Boot。GitHub 仓库需要添加 `dsh-plugin` Topic。

仓库满 24 小时并完成安装验收后，向 awesome-dsh-plugin 添加：

```yaml
url: https://github.com/simplifyOurLife/dsh-spring-boot-launcher
name: simplifyOurLife/dsh-spring-boot-launcher
category: dev
description:
  en: Launch and manage Maven Spring Boot services from DSH on Windows, with project discovery, profiles, status, logs, and a web panel.
  zh: 在 Windows 上通过 DSH 发现、启动和管理 Maven Spring Boot 服务，支持项目发现、Profile、状态、日志和 Web 面板。
```

投稿只修改 `data/plugins/simplifyOurLife__dsh-spring-boot-launcher.yml`，不手工修改市场生成的 README。

## 风险与回滚

- 客户端 ID 不一致：由安装契约测试直接捕获。
- Git 源安装遗漏文件：由 `npm pack --dry-run` 文件清单测试捕获。
- 根代理被绕过：根 manifest 测试固定 `main`/export 必须指向根 `src/index.js`。
- 本机迁移失败：保留 profile patch 备份，新旧 Junction 的删除都要求链接类型与目标完全匹配。
- GitHub 安装仍受 DSH/包管理器版本影响：先用隔离 profile 验证，再迁移日常 web profile；失败时恢复当前 Junction 配置，不改业务代码。
