# 参与贡献

感谢你帮助改进 DSH Spring Boot Launcher。项目当前聚焦 Maven Spring Boot，不接受把它扩展成其他服务类型启动框架的宽泛改造。

## 提交问题

启动问题通常与 POM、模块关系、JDK、Profile 和构建产物有关。请尽量提供：

- 最小化、可公开的目录结构；
- 脱敏后的 `pom.xml` 和必要配置片段；
- JDK、Maven、Windows 和 DSH 版本；
- 调用的 `spring_boot_*` 工具及参数；
- `modeReasons`、结构化错误码和脱敏日志；
- IDE 中能够成功启动时的关键配置差异。

不要提交真实业务仓库、凭据、内部地址或未经审查的完整日志。

## 开发约定

- 保持 Maven Spring Boot 专用定位，不新增未验证的平台或构建工具承诺。
- 新行为和缺陷修复应先增加能失败的回归测试。
- Host 与 UI 的协议字段、路由和 service marker 必须同步修改。
- 根 `src/index.js`、`package.json`、`cordis.patch.yml` 构成唯一公开 bundle；不要把内部 Host/UI 重新拆成两个公开 Loader 条目。
- 修改安装入口或 UI 模块身份时，保持客户端注册 ID 为 `dsh-spring-boot-launcher`，并运行根 bundle 契约及发行文件清单测试。
- 注释和关键错误信息优先使用中文，代码标识遵循现有英文命名。
- 不引入与需求无关的依赖或重构。

## 本地测试

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

自动测试不会执行 Java 或前端 build。若修改真实启动行为，还应在可信的 Maven Spring Boot 工程中验证检查、启动、日志和停止流程，并在 PR 中说明结果。

## 提交与 PR

提交信息使用简洁中文，例如：

```text
修复：避免陈旧 classes 被直接启动
测试：覆盖多模块工作区依赖
文档：说明 Windows 支持边界
```

PR 描述应说明问题、方案、风险、自动测试和人工验证，不要只罗列文件。
