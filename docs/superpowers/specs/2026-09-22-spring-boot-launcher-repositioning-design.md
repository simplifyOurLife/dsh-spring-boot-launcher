# DSH Spring Boot Launcher 开源定位与完整重命名设计

## 背景与目标

当前实现已经能够在 Windows 环境中发现、启动、停止和观察 Maven Spring Boot 服务，但项目名称、工具名称和设计文档仍将其描述为通用后端启动器或多语言 Launcher 框架。这与现有交付能力不一致，也会让开源用户误以为项目支持其他后端技术栈。

本次调整将项目明确定位为 DeepSeek Harness 的 Spring Boot 专用启动器，并在首次公开发布前一次性完成对外名称和内部稳定标识的重命名。首版只承诺已经验证的 Maven Spring Boot 能力；Windows 11 是当前唯一完成真实验证的平台，Linux 和 macOS 不作支持承诺。

## 范围与原则

本次采用不保留兼容别名的干净重命名。项目尚未正式发布，没有需要维持的公共 API；继续保留旧名称会增加长期维护成本，并持续强化错误定位。

调整遵循以下原则：

- 所有用户可见内容统一使用“Spring Boot 服务”和“Spring Boot 启动器”。
- 包名、目录名、工具名、控制路由、日志文件名和浏览器存储键统一采用 Spring Boot 语义。
- 删除“通用后端启动器”“语言无关核心”“由社区扩展 Go/Python Launcher”等尚未实现的宣传。
- 不把“尚未验证”表述为“确定不能运行”；Linux 和 macOS 仅标记为未验证、非当前支持范围。
- 不引入兼容层、迁移开关或额外抽象。

## 统一命名

| 当前标识 | 新标识 |
| --- | --- |
| `dsh-backend-launcher` | `dsh-spring-boot-launcher` |
| `dsh-backend-launcher-ui` | `dsh-spring-boot-launcher-ui` |
| `dsh-backend-launcher-workspace` | `dsh-spring-boot-launcher-workspace` |
| `backend_inspect` | `spring_boot_inspect` |
| `backend_start` | `spring_boot_start` |
| `backend_status` | `spring_boot_status` |
| `backend_logs` | `spring_boot_logs` |
| `backend_stop` | `spring_boot_stop` |
| `/backend-launcher` | `/spring-boot-launcher` |
| `/backend-launcher/ws` | `/spring-boot-launcher/ws` |
| `dsh-backend-launcher.log` | `dsh-spring-boot-launcher.log` |
| `dsh-backend-launcher:settings` | `dsh-spring-boot-launcher:settings` |
| UI 入口 `Backends` | `Spring Boot` |
| 运行状态集合 `backends` | `services` |

源码中的通用局部变量可以使用 `service`、`services` 或 `springBootService`。仅当引用第三方既有概念或历史事实不可避免时，才保留单词 `backend`；本项目自身的活动标识中不保留旧名称。

## 文件与组件调整

### 包与目录

两个包目录分别重命名为 `dsh-spring-boot-launcher` 和 `dsh-spring-boot-launcher-ui`。根目录 `package.json`、锁文件、CI、测试入口、安装示例和内部相对路径同步更新。截图名称改为能够表达 Spring Boot 服务面板的名称。

### Host 插件

Host 插件继续负责 Maven 项目发现、Spring Boot 入口识别、JDK 检测、运行模式决策、进程生命周期、日志和认证控制通道。此次不重构核心运行逻辑，只重命名接口和修正文案。

五个 Agent 工具改用 `spring_boot_*` 前缀，参数和返回结构除 `backends` 到 `services` 的语义调整外保持原有行为。工具描述明确限定 Maven Spring Boot，不再称为任意后端服务。

### UI 插件

侧栏入口和面板标题统一改为 `Spring Boot` 或 `Spring Boot Services`。客户端请求切换到新 HTTP/WS 路径，状态字段从 `backends` 改为 `services`，本地存储使用新键。由于尚未公开发布，不读取或迁移旧存储键。

### 文档

根 README 和包内 README 使用 `DSH Spring Boot Launcher` 作为项目名称，重点说明 Spring Profile、多模块 Maven、运行模式、日志和进程管理能力。

`DESIGN.md` 从多语言框架愿景调整为当前 Spring Boot 启动器的真实设计。历史开发记录可以保留问题背景，但不得继续作为当前能力或路线承诺。贡献指南聚焦 Spring Boot 项目结构、POM、JDK、Profile 和复现测试。

## 平台与兼容性声明

公开兼容性表采用以下口径：

- Windows 11、PowerShell 7、Maven Spring Boot：已验证。
- Maven 多模块 Spring Boot：已验证。
- Gradle Spring Boot：当前不支持。
- Linux、macOS：尚未验证，不属于当前支持范围。
- Go、Python、Node.js 等其他服务类型：不属于项目定位。

CI 继续以 Windows 为唯一验证环境。在真实跨平台验证完成前，不添加跨平台徽章或兼容承诺。

## 安全与错误处理

现有安全模型保持不变：插件通过 DSH 认证后的同源通道控制本机进程，使用当前用户权限启动可信工程，并限制控制请求的 Host、Origin、请求体和 WebSocket 消息大小。

重命名后，认证失败、项目识别失败、JDK 缺失、Maven 准备失败和进程停止失败等行为保持原样。日志和错误信息中的组件前缀改为新名称，便于用户定位来源。

## 验证方案

修改完成后执行以下验证：

1. 运行 Host 和 UI 现有测试，确认新包路径、新路由、新工具名和 `services` 状态结构一致。
2. 运行根目录测试入口，验证两个包可以一起完成回归测试。
3. 全仓扫描旧包名、旧路由、旧工具名和用户可见的 `Backends` 文案。
4. 检查 README、安装示例、CI、锁文件和截图引用不存在断链。
5. 不执行前端或后端 build；由用户在本地 DSH 与真实 Spring Boot 工程中完成最终启动验收。

允许在历史实施记录中保留旧名称以说明当时状态，但必须明确标记为历史记录，且不能被当前 README 链接为现行设计。测试夹具中不应为了历史兼容保留旧接口。

## 非目标

本次不实现 Gradle、Linux/macOS 适配、多语言服务启动、插件市场发布、npm 公共发布、进程跨 DSH 会话恢复或新的启动模式。它们若后续需要，应分别设计和验证，不作为此次重命名的隐含范围。

