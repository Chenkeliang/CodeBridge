# CodeBridge npm 交付候选

## 范围

承接已完成的初始化向导，完成交付阶段的版本号、变更记录、npm 打包和干净目录安装验收。保持源码安装、现有配置和服务启动逻辑。当前版本沿用仓库的 0.1.0，标记为未公开发布的候选。没有本轮 npm 发布、tag、GitHub Release 或线上部署授权。

## 实施

1. 根 package.json 为版本源，工作区版本检查/同步脚本防止漂移；运行时 VERSION 从 core 包元数据读取，Runner 支持无配置的 --version / --help。
2. 在 dist 下生成 npm tgz：只复制内部包的生产编译产物、Web 静态资源和明确列出的说明文件，使用 npm bundleDependencies；去除开发脚本、源码、测试和源映射，内部 workspace: 引用改为候选版本。源码仓库继续 private，防止误发布源文件。
3. 用独立临时目录 npm install tgz；验证两个 CLI 的版本、帮助、无 TTY 初始化、配置不覆盖、所有内部模块导入、独立 Runner 健康检查和 Bridge Web 静态资源。禁止真实通道调用及 Agent 执行。
4. 增加 CHANGELOG、发布/安装文档和 CI 打包验收。全量构建、lint、测试和包安装检查完成后交付产物。

## Surface Matrix（验收前）

| Surface | entry / read / write / events | error / recovery / feedback | 状态与计划 |
|---|---|---|---|
| CLI | npm bin → 既有 Bridge/Runner；版本取包元数据；init 写临时配置 | 无配置 help/version；缺构建/版本漂移打包失败；安装测试清理自身进程 | planned：本阶段打包与安装测试 |
| Web | npm 内部 web 包 dist → 现有 createWebFrontend；不改页面 | 包中静态资源完整；隔离 Bridge HTTP 验证 | planned：本阶段静态资源验收 |
| Agent | 内部 backends/runner-host 随包分发；现有 worker 文件相对路径保留 | 模块导入及 MCP 入口存在；不真实运行 Agent | planned：本阶段模块/入口验收；真实 Agent 执行不在范围 |
| 飞书 | 既有通道入口与依赖随包分发；不改 token 或事件处理 | 模块导入和原回归测试；不连接真实机器人 | existing implemented；本阶段验证安装可达，外部 closed-loop 不声明 |
| Telegram | 同上；沿用向导白名单和凭据校验 | 模块导入和原回归测试；不读取真实更新 | existing implemented；本阶段验证安装可达，外部 closed-loop 不声明 |

## 边界

原更大清单中的运行数据维护、错误提示治理、可观测性、贡献文档和插件化等仍为后续阶段；Linux 支持按用户要求排除。本阶段不得将候选 tgz 的安装通过表述为已公开发布。

参考：npm package.json 文档中的 bundleDependencies（https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bundledependencies）。

## 本次验收结果

- `pnpm build`：通过；保持已有字体文件和大 chunk 提示。
- `pnpm lint`：0 errors，7 warnings（均来自未修改的 Web 文件）。
- `pnpm test`：143 个文件、1333 项通过；其中 npm 打包新增 4 项回归测试。
- `pnpm version:check`：18 个 package.json 的版本均为 0.1.0。
- `pnpm test:package`：真实 npm 安装 tgz 后通过两个 bin、元数据版本变更、无配置 help/version、init 权限及幂等、内部包导入、Runner 401/健康版本、Workbench HTML/JS 静态资源测试；正常清理临时进程及目录。PATH 不包含本机 Agent CLI，测试环境不继承提供方密钥。
- 包内文件检查：429 项，未包含 src、测试、源映射、config.yaml、.env 或 Git 目录；内部 manifest 无 workspace: 引用。
- CI 已加入版本检查、打包、安装验收；仅本地执行过这些命令，尚未推送触发 GitHub CI。
- 产物：`dist/codebridge-0.1.0.tgz`；本文上面的数字记录本轮初始验收，合并前最终重建及复核见 `docs/zh-CN/release-review-2026-10-10.md`。

### Surface Matrix（验收后）

| Surface | implemented / reachable / closed-loop | 证据与限制 |
|---|---|---|
| CLI | 均通过（隔离安装环境） | 包的实际 bin 运行、动态包版本读取、帮助、init 写入和重复运行完成 |
| Web | implemented、reachable；HTTP 静态资源链路 closed-loop | 实际安装包启动 Bridge 并返回 Workbench HTML 与 JS；页面代码未改，本次不声称浏览器交互验收 |
| Agent | 模块及 worker 入口存在，模块导入可达；任务 closed-loop 未测试 | 内部包导入与 deployment-mcp-server 文件检查；不启动真实 Agent CLI 或提交任务 |
| 飞书 | 原通道实现随包可导入；真实服务 closed-loop 未测试 | 既有通道回归测试通过，安装验收不配置真实凭据 |
| Telegram | 原通道实现随包可导入；真实服务 closed-loop 未测试 | 同上，未拉取真实消息 |

### 影响检查与 Git 状态

GitNexus 已重建当前 checkout 索引；Runner main 为 LOW（1 个直接入口），stageRelease 为 LOW（4 个上游符号，仅脚本链路）。VERSION 常量在图中为 UNKNOWN，已检索源码确认其用于 Bridge CLI 与 Runner 健康信息，候选版本仍为 0.1.0。

包括上轮向导修改和本轮新增文件的 detect-changes 聚合检查仍返回 critical / 195 flows，包含之前已证明不成立的测试局部 `run` 同名函数关联。保留该提示，未宣称图工具全绿；实际源码调用范围和安装测试作为交叉验证。新文件使用 intent-to-add 纳入 diff 检查，尚未提交。

以上记录的是合并前开发阶段。后续 Git 合并与部署状态以仓库历史和发布器记录为准；npm 公开发布不在本次授权范围。
