# Orchestration 配置形状参考

这些文件只展示 CodeBridge 配置契约，不连接生产环境，也不会自动注册项目或启用能力。仓库不提供可运行的业务流程或测试 Workflow。

```text
agents.yaml              Agent Profile
capabilities.yaml        Capability 到 Skill/MCP 的绑定
environments.yaml        环境和写入策略
projects.yaml            项目 Catalog 候选示例
workspaces.yaml          工作空间和发现来源
```

正式项目、Agent 和 Capability 必须由运行时 Discovery、用户确认或受控注册流程产生，并补充来源证据、Review 记录、Schema 校验和环境绑定。
