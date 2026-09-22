# DSH Spring Boot Launcher

DSH Spring Boot Launcher 为 DeepSeek Harness 提供 Maven Spring Boot 项目检查、启停、状态和日志能力。Host 与 Web 面板共用同一个进程注册表，避免 Agent 操作和界面操作产生两套状态。

当前 Alpha 版本只在 Windows 11、PowerShell 7 和 Maven Spring Boot 项目中完成验证。Gradle 当前不支持；Linux 和 macOS 尚未验证，不属于当前支持范围。

## 环境要求

- 能够加载本地 Cordis 插件的 DeepSeek Harness。
- Node.js 22.22.2 是本机和 CI 验证基线。
- 与目标工程兼容的 JDK。
- 需要构建时可使用 `mvn`，或者目标项目已有可运行产物。
- Web 面板需要宿主提供已认证的 `dsh-client-connection` 和 `dsh-host-webserver` 接口。

## 安装与加载

在仓库根目录执行以下 PowerShell 命令，把两个包以 Junction 方式连接到 DSH profile：

```powershell
$dshModules = Join-Path $env:USERPROFILE ".dsh\profiles\node_modules"

New-Item -ItemType Directory -Force -Path $dshModules | Out-Null
New-Item -ItemType Junction `
  -Path (Join-Path $dshModules "dsh-spring-boot-launcher") `
  -Target (Resolve-Path ".\dsh-spring-boot-launcher")
New-Item -ItemType Junction `
  -Path (Join-Path $dshModules "dsh-spring-boot-launcher-ui") `
  -Target (Resolve-Path ".\dsh-spring-boot-launcher-ui")
```

如果目标 Junction 已存在，请先确认其目标，不要覆盖未知目录。

在目标 profile 的 `cordis.patch.yml` 中加载两个包：

```yaml
- insert:
    - { id: spring-boot-launcher, name: dsh-spring-boot-launcher }
    - { id: spring-boot-launcher-ui, name: dsh-spring-boot-launcher-ui }
```

完整重启 DSH 并刷新已登录页面。侧栏出现 **Spring Boot** 后即可打开管理面板。已有 Agent 会话可能保留旧工具快照；若工具未出现，请新建会话。

## Agent 工具

| 工具 | 主要参数 | 作用 |
| --- | --- | --- |
| `spring_boot_inspect` | `dir` | 检查 POM、入口类、Profile、JDK、端口和推荐运行模式 |
| `spring_boot_start` | `dir`、`profile`、`port`、`mode` | 准备并启动服务，返回进程、健康状态和日志路径 |
| `spring_boot_status` | `dir`（可选） | 查询一个服务或全部已托管服务 |
| `spring_boot_logs` | `dir`、`lines` | 读取最近日志 |
| `spring_boot_stop` | `dir` | 停止服务及其进程树 |

`spring_boot_start` 还支持 `jvmArgs`、`build`、`noBuild`、`mvnOffline`、`detach` 和 `jarPath`。通常保留默认 `auto` 模式，只在排查启动决策时显式指定模式。

## 启动模式

```text
检查 Maven Spring Boot 项目
   ├─ 可用且新鲜的 thin jar ──────────> jar-run
   ├─ jar 过期、classes 新鲜 ─────────> direct-classpath
   └─ 产物缺失或 classes 过期 ────────> Maven 准备/编译后启动
```

每次选择都会通过 `modeReasons` 返回原因。启动器不会为了快速返回而静默运行已过期字节码。

## 控制通道与日志

- HTTP：`/spring-boot-launcher`
- WebSocket：`/spring-boot-launcher/ws`
- 日志文件：`<项目>/logs/dsh-spring-boot-launcher.log`
- 浏览器设置：`dsh-spring-boot-launcher:settings`

HTTP 和 WebSocket 均复用 DSH 登录态，只允许回环、同源和实际监听端口请求。认证能力缺失时拒绝启动控制通道，不回退到无认证模式。

## 测试

从仓库根目录执行：

```powershell
npm test
```

自动测试不会执行 Java 或前端 build。真实环境仍需验证 DSH 重启、项目扫描、Profile 选择、启动、日志和停止流程。

架构说明见 [DESIGN.md](DESIGN.md)，贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。
