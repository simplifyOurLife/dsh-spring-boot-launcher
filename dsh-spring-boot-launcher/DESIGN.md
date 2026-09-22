# DSH Spring Boot Launcher 设计说明

## 定位

本项目是 DeepSeek Harness 的 Maven Spring Boot 专用启动器，不是通用服务启动框架。当前实现围绕 Spring Boot 的 POM、入口类、Profile、JDK、Maven 模块关系、运行模式和健康状态展开。

## 组件

```text
dsh-spring-boot-launcher/
  src/index.js              插件入口、项目检查、进程注册表和五个 Agent 工具
  src/launch-policy.js      参数校验、JDK 选择和命令安全边界
  src/jdk-discovery.js      JDK 候选发现
  src/control-transport.js  已认证 HTTP/WS 控制通道
  src/log-storage.js        固定日志文件与轮转
  src/log-pump.js           增量日志读取与尾部同步
  src/health-check.js       启动健康检查

dsh-spring-boot-launcher-ui/
  lib/client.js             工作区扫描、服务面板、实时状态和日志界面
```

Host 与 UI 通过 `/spring-boot-launcher` 和 `/spring-boot-launcher/ws` 通信。Agent 工具和 HTTP 控制处理器调用同一组启动/停止核心函数，并共享同一个内存进程注册表。

## 项目检查

`spring_boot_inspect` 从 `pom.xml`、源码目录和配置文件提取：

- Spring Boot 入口类与版本线索；
- Maven 父子模块和工作区内部依赖；
- Spring Profile、端口与资源目录；
- 目标 JDK 需求和本机候选 JDK；
- jar、classes 和依赖目录的新鲜度；
- 推荐运行模式和可解释的 `modeReasons`。

无法确认 Maven Spring Boot 项目时返回结构化的不匹配结果，不尝试猜测其他服务类型。

## 启动决策

自动模式优先保证执行当前源码：

1. 新鲜且结构合适的 jar 使用 `jar-run`。
2. classes 新鲜且依赖目录完整时使用 `direct-classpath`。
3. 产物缺失或过期时，通过 Maven 准备 classes 和运行依赖后启动。

多模块项目会识别 reactor root 和声明依赖，只把当前应用真实依赖的兄弟模块产物加入 classpath。已知会遮蔽内嵌容器的遗留 API jar 会被排除，但不会删除用户文件。

## 进程与状态

进程注册表以规范化项目路径生成的 `projectKey` 为键。每个条目保存 ShellProcess、启动时间、命令、端口、模式、健康状态和日志缓冲。

- 同一项目的并发启动通过互斥逻辑收敛为单个进程。
- GUI 和 Agent 查询得到相同状态。
- 停止时先请求进程树退出并读取尾日志，必要时再使用强制停止。
- 当前不恢复跨 DSH 会话的历史进程。

## 日志

控制台输出同时进入最多 512 KiB 的内存尾部缓冲、WebSocket 推流和 `logs/dsh-spring-boot-launcher.log`。日志文件按 10 MiB 轮转，最多保留四份；文件写入失败不会中断内存日志和服务状态管理。

## 安全模型

Maven 与 JVM 需要写入项目 `target/`、`logs/` 和本地 Maven 仓库，因此启动命令使用当前用户权限。插件只适合可信工程，不提供不可信代码隔离。

控制通道必须满足：

- 宿主监听 `127.0.0.1`；
- HTTP Host 与实际端口一致；
- Origin 同源且拒绝 cross-site；
- DSH 登录校验接口存在并通过；
- 请求体和 WebSocket 入站消息有大小限制。

## 当前边界

- 已验证：Windows 11、PowerShell 7、Maven Spring Boot、多模块项目。
- 不支持：Gradle Spring Boot。
- 未验证：Linux、macOS。
- 非目标：其他服务类型、公共扩展注册表、跨会话进程恢复。
