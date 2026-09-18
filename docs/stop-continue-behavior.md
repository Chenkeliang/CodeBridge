# Stop 后继续原会话

用户请求取消当前运行时，只取消正在运行的 Run，已排队的 Turn 保留不动。运行确认 cancelled 后队列回到 ready 并自动 dispatch 已排队的 Turn；取消请求之后提交的新消息同样排队并自动依次执行，无需 /c。重复取消请求不影响已排队或后来的消息。

执行失败、系统中断等仍按原有逻辑暂停。历史已暂停队列不自动恢复。该变化不新建 Session，不改变用户授权或模型配置。

| Surface | entry/read/write/event | error/recovery/feedback | 状态 |
|---|---|---|---|
| 飞书 | /stop → cancellation API → Coordinator → cancelled → 新消息 dispatch | 失败暂停保持，现有停止回执 | implemented；部署后真实操作待验证 |
| Telegram | 共享 cancellation API 和 Coordinator | 同上 | implemented；通道未启用，未实测 |
| Web | 共享运行取消 API | 同上 | implemented；浏览器未实测 |
| Agent | 接收取消，终止后才允许下一个运行 | 避免同 Session 并发 | Coordinator 回归验证，真实运行待验证 |

无新增 planned 功能。验收覆盖：旧消息取消、新消息直接执行、停止期间新消息等待、重复停止不误取消、失败与手动暂停仍保留。
