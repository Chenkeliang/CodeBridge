# Codex 联网配置：保留 ACP

## 范围与验收

保留 CodeBridge → ACP → codex-acp → Codex App Server 的调用链。CodeBridge 设置适配器声明的布尔配置项 `network_access`，不选择完全访问模式、不修改 Codex 全局配置。后端默认配置与现有会话覆盖合并；会话覆盖优先，每轮重新设置并读回。明确请求的联网配置缺失、设置失败或读回不一致时，在 prompt 前终止。

本次用户选择“先只改 CodeBridge，准备适配器源码改动供后续接入”。不克隆上游、不推送、不提交上游 PR、不发布、不切换生产配置。当前生产的依赖补丁保留，正式适配器支持上线后再迁移。

实施：新增后端 `acpConfig` 默认值；接入现有 set_config_option 路径并为 Codex 联网配置增加强校验；保存可审查的上游源码 diff；提供升级前能力检查和新会话、复用续聊、冷启动续聊的验收入口。升级检查只进行 ACP 会话与配置请求，不发送模型任务；完整验收显式运行并使用隔离工作区、只读 DNS/TCP 与专用文件。

验证：合同测试覆盖布尔协商、默认值/覆盖、false、配置缺失、RPC 失败、读回不一致、模式与联网的设置顺序；真实 ACP 子进程测试覆盖新会话与 resume；既有构建、lint、测试通过。上游尚未实现/发布，不把模拟适配器验收声称为已发布版本的生产验收。

## 影响与表面矩阵

GitNexus `applySessionConfigOptions` 与 `runAcpSession` 均为 LOW，前者一个直接调用者，后者通过 Runner 接入通道。配置 schema 和部署器的 UNKNOWN 来自未建立变量/动态调用边，需以源码调用链补证，不解释为无人使用。

| 表面 | entry / read path | write path / events | error / recovery / terminal | 前状态 → 目标状态 |
| --- | --- | --- | --- | --- |
| Web | 会话配置 → API → 会话 configOverrides → Runner | 后端默认与会话覆盖合并 → ACP 配置响应 → 原事件流 | 不支持配置时 fatal；后续轮次重设；显示既有终态 | 配置已实现且可达 → 保持入口，合同与模拟 Runner 闭环；线上 UI 不发测试任务 |
| Agent | Runner.executeRun → runAcpSession | 标准布尔 set_config_option，读回后才 prompt | 缺失/失败/错误读回终止；新会话与续聊均应用 | 原配置路径可达 → 新联网配置合同与真实 ACP 进程闭环 |
| 飞书 | /config、会话覆盖 → Bridge → 同一 Runner | 共用后端配置规则及事件投影 | 复用原错误、重试、终态反馈 | 保持 implemented/reachable；不发送真实飞书消息，不声称新 UI 实测 |
| Telegram | /config、会话覆盖 → Bridge → 同一 Runner | 共用后端配置规则及事件投影 | 复用原错误、重试、终态反馈 | 保持 implemented/reachable；不发送真实 Telegram 消息，不声称新 UI 实测 |

无新增 UI 或跨表面跳转。正式生产 closed-loop 验收落点：上游适配器发布并获接入授权后，两个启用的 Codex 后端分别运行新会话与续聊验收。
