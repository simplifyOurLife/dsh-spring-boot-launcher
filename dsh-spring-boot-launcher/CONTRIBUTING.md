# Spring Boot 启动器贡献指南

本包的实际入口为 `src/index.js`，Web 客户端位于 `../dsh-spring-boot-launcher-ui/lib/client.js`。

## 适合的贡献

- Maven Spring Boot 项目发现和 POM 解析修复；
- Spring Profile、端口、入口类和 JDK 识别改进；
- `jar-run`、`direct-classpath` 和 Maven 准备流程修复；
- 多模块依赖、classpath 冲突、日志和进程生命周期修复；
- Windows 真实工程的可复现问题；
- Linux/macOS 的独立验证结果与针对性修复，但在验证完成前不宣称全面支持。

Gradle 支持需要单独设计、测试和真实工程验证，不应通过伪装成 Maven 路径的小补丁加入。

## 回归测试

Host 测试位于 `tests/`，每个套件使用独立临时目录。新增缺陷修复时：

1. 先用最小夹具复现错误并看到测试失败；
2. 修改实现使该测试通过；
3. 从仓库根目录运行 `npm test`；
4. 若影响真实启动，再记录人工验收环境和结果。

测试不得依赖真实业务工程、内部 Maven 仓库或本机 DSH 安装。

## 安全要求

不要降低回环、同源和登录校验要求，不要增加无认证回退。任何涉及命令构造、路径、JVM 参数或进程停止的修改，都应覆盖恶意或异常输入。

