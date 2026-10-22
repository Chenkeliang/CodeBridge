# Runner 初始化与会话锁超时

## 目标和授权

定位 ACP 初始化及会话锁超时，修复可复现根因，验证后合并 main、推送、上线。范围是启动等待的超时判定；不放宽业务权限、不重发 prompt、不增大原有 30 秒 / 5 秒期限。

## 证据与边界

线上 c6d763d 的 Bridge 和 8e3a0a0 的 Runner（此后二者涉及的 Runner/ACP 源码没有差异）：20:33 原话题 Codex 初始化超时；20:34 同一会话获取内核锁辅助进程就绪信号超时。两次仅持久化 error/done，没有进入 Agent 执行。会话未归档、未找到占用者。事后同配置只读 ACP initialize 成功 714ms，临时锁成功 47ms。

隔离真实子进程复现：500ms 的 ACP 等待期限，子进程 41ms 就写出响应，但父进程暂停 1000ms 后先处理超时轮询，错误报超时；原内核锁等待在父进程暂停 6000ms 后也报 5000ms 超时。代码都在超时回调处直接失败，尚未处理已排队的管道 I/O。

这是可验证的共同缺陷。历史现场没有 Runner 调度与子进程逐阶段采样，不能据此断言两次历史失败只有这一个原因；当前主机资源压力是可能的触发条件，而不是用来代替代码证据的结论。

## 修复方案

到达期限后给本轮已排队的 I/O 一次处理机会，再判定是否仍未就绪。已就绪的响应应成功；仍未响应则按原期限报错。ACP 等待在这一步仍优先响应取消；会话锁的迟到超时回调不能杀掉已经成功交付的锁持有者。

## Surface Matrix

| Surface | entry/read/write | event/error/recovery/terminal | implemented/reachable | closed-loop / 验证 |
| --- | --- | --- | --- | --- |
| Agent/Runner | RunRequest → 内核锁 → ACP initialize → load/resume → prompt | 就绪/超时/取消与原有清理 | 现有线上入口，候选修复已实现 | 真实临时子进程和内核锁回归；模拟 ACP 全流程 |
| 飞书 | 原话题 → Session Runtime → Runner | error/done → session-watcher 失败回执 | 源码已核实 | 既有表面测试；发布后自然流量观察，不主动发送业务消息 |
| Web | Session API → 同一 Runner | 原有 SSE、错误与取消 | 共享入口，无 UI 改动 | 全量 Session API 测试；无真实浏览器闭环声明 |
| Telegram | ingress → 同一 Runner | 原有 watcher | 共享入口，无通道改动 | 全量既有测试；无真实 Telegram 闭环声明 |

## 验证与发布

GitNexus 在 c6d763d 重建索引；raceWithAbort 上游 7 个直接调用、18 个受影响符号，CRITICAL，修改前已告知。acquireKernelLock 影响限于 Runner 会话租约调用链。测试只使用临时文件、临时子进程及模拟 ACP；不调用模型或发送消息。

`pnpm build` 通过；`pnpm lint` 通过（7 条既有 Web warning）；`pnpm test` 148 文件 / 1391 测试全部通过。将两处生产代码临时还原到基线后，两个真实子进程停顿回归均失败；恢复修复后通过。新增真实 ACP 管道、真实 lockf 内核互斥及 3 项模拟时序测试，验证超时后已就绪、真实无响应、排队锁冲突及迟到计时器不杀已交付 holder。

真实 codex / codex-profile 配置只握手验证：测试等待期限 2000ms，暂停独立测试父进程 3000ms，恢复后两者均收到 protocol=1（分别 3009ms/3018ms 返回）；没有创建/续聊业务会话或发送 prompt。

分支 fix_runner_startup_deadlines 基于 fetch 后的 origin/main c6d763d，创建时独有提交数 0。用户已授权合并 main、推送和上线；发布结果以发布器状态及线上健康验证为准。
