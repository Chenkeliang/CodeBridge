# 飞书群告警自动排查

CodeBridge 使用 `@larksuiteoapi/node-sdk`，不依赖飞书 CLI。告警监控以小 V 的应用身份定时调用群历史消息接口，处理指定机器人的新消息，复用已有 Agent Session 和飞书流式卡片回复。普通群消息自动回复和主动采集机器人告警是两个入口。

## 配置

在 CodeBridge 配置 `feishu` 下增加以下配置，填写真实群、告警发送方应用 ID 和负责人在小 V 应用下的 open_id：

```yaml
feishu:
  # 保留已有 appId、appSecret 和 policy
  alertMonitor:
    enabled: false # 试运行阶段保持停用；验收并发布后再启用全量
    pollIntervalMs: 60000
    lookbackMs: 600000
    dedupWindowMs: 1800000
    maxConcurrent: 2
    statusReactions:
      investigating: OnIt
      waiting: OneSecond
      resolved: DONE
      no_action: CrossMark
      blocked: Sigh
    groups:
      - chatId: oc_your_alert_group
        senderAppIds:
          - cli_your_alarm_sender
        ownerOpenId: ou_your_owner
        runbookPath: /absolute/path/to/feishu-alert-triage/SKILL.md
```

缺省不启用。部署包含本功能的版本后再配置；运行时配置更新沿用 ConfigStore，移除 `alertMonitor` 会停止新告警采集，已有告警话题的负责人校验仍保留。首次启用从当前时刻开始，不追溯处理已有历史告警。

机器人必须在该群，并具备读取群内所有消息和发送/回复消息所需权限。本次在「灯塔推送」已实测应用身份能读取另一机器人的 webhook 告警：API 返回 `post` 富文本，标题、数据与错误信息都可取得。不能只筛选 `interactive` 类型。

## 行为

- 仅采集配置的群和发送机器人；群友普通消息、回复串及其他机器人不启动自动排查。
- 示例配置每 60 秒检查（代码缺省间隔仍为 30 秒），持久化时间窗口和分页游标。每轮从上次成功进度往前回看 10 分钟，按消息 ID 去重，补抓延迟出现的消息；首次启用之前的消息仍跳过，关机后仍从旧进度补读至当前。`lookbackMs` 可调整，最长 24 小时；超出回看窗口才出现的旧消息不保证自动找回。
- 同一消息只提交一次，相同来源和相同正文在 30 分钟内合并，不重复排查。
- 同时自动排查最多两条，其余保留待处理。维护期间暂停采集/提交；读取失败保留进度，提交失败以原消息 ID 重试。
- 首条告警根消息对应独立 Session，排查卡片在原消息话题中回复；后续本人回复继续该 Session。
- 自动任务仅授权只读排查。每次需要改数据、重试、补发、重启、发布或其他业务操作，Agent 必须先原生 @ 负责人，说明证据、对象和具体动作，结束本轮并等待本人回复。
- 仅负责人在该告警话题内的消息可继续任务或进入审批命令；告警正文、他人消息和过去的批准均不构成当前授权。本人本次回复只授权明确提到的具体动作，含糊回复需要澄清。
- 不修改告警发送方卡片；进展与结果写到小 V 自己的回复卡片。

`feishu-alert-monitor.json` 保存采集进度、去重记录和话题负责人。保留这个文件；删除它会丢失已有话题的负责人映射。不要复制不同实例的状态或同时运行多个 Bridge 进程共用同一数据目录。

## 权限边界与验收

只读排查和逐次确认通过任务指令与入站负责人校验实现。它不是为所有 Agent/任意 shell/MCP 工具新增硬只读沙箱；现有 Agent Permission 和业务 skill 的 dry-run/确认仍必须遵守。

合同测试覆盖分页、重启、延迟消息、去重、并发和负责人；飞书表面测试经过实际 `FeishuBridge` 入口，以模拟 SDK 验证线程回复、通知 open_id 和本人回话路由。真实 SDK 群消息读取成功不等于真实群内整个自动流程已验收。发布后需用一条新告警验证原话题排查、原生 @、本人回复及终态。


## 原卡片表情与标准流程

状态表情直接挂在原告警消息上，不发送单独表情消息。等待本人或排查受阻时，后端同时原生 @ 配置的负责人，摘要是具体待办；Agent 不再额外重复发一次 mention。

Agent 使用 `fcb alert status <investigating|waiting|resolved|no_action|blocked> "证据或待办"`。`/outbound/alert-status` 仅接受当前活动 Run 的持久化飞书来源，不接受调用方自选群/消息，也不向外部 publisher 凭据开放。状态记录与 Reaction 投递分离保存，失败后重试；只替换本应用自己的五种状态表情，保留其他人及本应用非状态表情。

`resolved` 要有业务复查证据，`no_action` 表示核实不需操作。Agent Run 已结束但未提交可核验结论时改为 `blocked`，不会自动标成功。重复告警的原卡片投影到同一案件状态。

配置 `runbookPath` 后，每次新告警及本人后续回复重新读取该 SKILL。SKILL 再读取当前告警矩阵，复用业务 skill 的只读查询与确认规则；未知类型添加 draft，真实证据或用户纠正更新已有分支。缺失/不可读的流程文件不能静默绕过。

试运行可预置已验证的五条案件与负责人记录，标记 `collectionStarted: false`；开启连续采集时重设起点为启用时刻，同时保留试运行话题的本人校验。预置记录不代表后台自动入口已经运行。
