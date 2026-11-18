# 持续结案规则维护

持续结案规则以本群的 `references/closure-rules.json` 为准。矩阵引用规则 ID，继续记录排查步骤、证据来源和技术说明。配置中的条件由值守 Agent 逐单核实，Bridge 校验规则、原始授权、当前案件和答复投递。

## 检查已有规则

从当前群已采集的告警选一个代表性样本。在 CodeBridge 主机使用已更新的 CLI：

```sh
codebridge closure-rule check --chat oc_example --sample om_example_alert --rule-id EXAMPLE-CLOSE
```

预检不写文件，不修改告警状态。它区分未登记、停用、样本不匹配和授权失效。样本可用于预检旧告警；若结果的 `sampleAfterAuthorization` 为 false，该告警仍早于授权时间。

## 新增规则或调整适用范围

1. 准备草稿并选原话题中已被采集的告警作为样本。在本群原话题给审批人说明发送方、告警类型、命中原因、逐单条件及自动 DONE 的范围。
2. 草稿先省略 `authorization`。执行 `check --draft example-rule.json`。样本及规则字段通过时，结果会返回 `approvalLine`，它绑定本群、规则 ID 和草稿的适用范围。审批人在原话题回复这一行完成一次授权。
3. 将批准消息 ID 写入草稿的 `authorization.messageId`，执行同样参数的 `save --draft example-rule.json`。保存会重做预检并从飞书原文计算摘要。
4. 把结果返回的 `matrixReference` 用在本群矩阵。核验后续新告警时，从这条规则查条件并按现有 `dismissed` 接口提交。保存规则不触发案件结案。

草稿示例：

```json
{
  "id": "EXAMPLE-CLOSE",
  "kind": "after_triage",
  "verified": true,
  "senderAppIds": ["cli_example"],
  "title": "示例：权益交付异常",
  "bodyIncludes": ["示例错误原因"],
  "conditions": "逐单核验示例条件成立后才适用",
  "evidence": "本群批准的处理口径"
}
```

已登记、已启用且范围相同的规则可以省略草稿中的授权部分，保存时复用已登记的原始批准。完全相同的内容直接返回 `changed=false`。如果原批准被编辑、撤回或人员权限改变，预检会给出原因。停用规则恢复和范围变化需要一次针对本次范围的有效批准。这个本机入口服务于受信任的规则维护流程。审批人要核对原话题中展示的草稿，核验单个代表性样本无法覆盖所有未来告警。

## Surface Matrix

| Surface | 入口、读取和写入 | 错误、恢复和终态 | 本次状态 |
|---|---|---|---|
| Web | 同源本机管理 API 接受预检和保存，现有规则编辑器继续提供文件读写 | 读到独立错误码，文件竞争时重读，已有文件保留加密备份 | 管理 API 合同验证，浏览器未新增入口 |
| Agent | 主机上的 `codebridge closure-rule` 经现有管理接口查样本、原授权并登记 | 重试会复核权限和文件版本，同一规则返回未变化 | CLI 与本机管理接口本地验证，生产部署待另行执行 |
| 飞书 | 当前群原话题的批准消息用已有 SDK 读取 | 按实际作者、群、话题和原文校验。后续 DONE 仍由现有值守流程投递 | 模拟飞书读取的活跃入口合同验证，真实群未发验收消息 |
| Telegram | 规则维护针对已配置的飞书告警群 | 无跨通道入口 | 无新增能力或跳转 |
