# 开源发布检查清单

## 定位与命名

- [x] 项目名称统一为 DSH Spring Boot Launcher。
- [x] 包、目录、工具、路由、日志文件和浏览器存储键使用 Spring Boot 语义。
- [x] 删除通用服务启动框架和其他服务类型扩展宣传。
- [x] 明确 Maven Spring Boot 专用范围。

## 平台声明

- [x] Windows 11、PowerShell 7 标记为已验证。
- [x] Maven 与 Maven 多模块 Spring Boot 标记为已验证。
- [x] Gradle 标记为当前不支持。
- [x] Linux/macOS 标记为尚未验证、非当前支持范围。
- [ ] 在公开仓库首次运行 Windows CI。

## 安全与隐私

- [x] HTTP/WS 使用 DSH 登录态、回环和同源校验。
- [x] 请求体、读取时间和 WebSocket 消息大小有限制。
- [x] README 与安全策略说明 Maven/JVM 使用当前用户权限。
- [x] 公开文档和设计说明不包含真实业务工程名称、内部地址或凭据。
- [ ] 发布前人工复查截图、示例路径和日志片段。

## 质量

- [x] Host 与 UI 自动测试由根目录 `npm test` 统一执行。
- [x] Windows GitHub Actions 使用 Node.js 22.22.2 和锁文件安装。
- [x] CI 包含高危依赖审计。
- [ ] 在新的公开仓库验证首次 CI 结果。
- [ ] 在真实 Maven Spring Boot 工程中复验扫描、Profile、启动、日志和停止。

## 分发

- [x] Apache-2.0 许可证已添加。
- [x] 根 README 提供源码安装入口。
- [ ] 确定公开仓库地址与维护者安全联系方式。
- [ ] 决定是否以及何时移除包的 `private` 标记并发布 npm 包。

完成所有未勾选项目后，再将 Alpha 描述调整为更稳定的发布状态。
