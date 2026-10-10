# npm 安装与发布

发行版本为 `@graychennpm/codebridge@0.1.0`，可从 npm 安装，也可使用本地 tarball。macOS 是本阶段支持的宿主机；不新增 Linux 服务管理。

## 安装

需要 Node.js 22.19 或更高版本，无需源码、TypeScript 或 pnpm：

```bash
npm install -g @graychennpm/codebridge@0.1.0
codebridge --version
codebridge-runner --version
codebridge init
```

也可以使用 `npm install -g /absolute/path/graychennpm-codebridge-0.1.0.tgz` 安装已下载的 tarball。

完成向导后，在两个终端分别执行：

```bash
codebridge-runner
```

```bash
codebridge start
```

检查连接：`codebridge doctor`。需要 Web 工作台时，设置配置中的 `web.enabled: true`，然后访问启动日志中的 `/workbench/` 地址。Agent CLI 的安装、登录和模型提供方认证仍需按各工具要求完成；安装此 npm 包不会替你创建外部账号或发送消息。

`codebridge init --defaults` 只生成权限 `600` 的默认配置和随机 Runner token，不校验通道；非交互初始化行为与源码安装一致。首次交互向导优先存入系统钥匙串。npm 安装不包含源码仓库的 `scripts/start.sh` 或宿主机部署器，因此源码安装的后台管理和受控部署流程保持独立；此安装方式提供前台 CLI 运行方式。

## 构建与安装验收

在源码仓库运行：

```bash
pnpm install --frozen-lockfile
pnpm version:check
pnpm package:release
pnpm test:package
```

输出位于 `dist/graychennpm-codebridge-0.1.0.tgz`。`package:release` 先完整构建，再调用 npm 原生 `pack`。脚本仅暂存内部包的编译输出和 Web 静态资源，去掉测试、源码映射、开发脚本及开发依赖；不复制用户配置、凭据、源代码或工具目录。

17 个内部包通过 `bundleDependencies` 随 tarball 分发，不需要单独发布 `@codebridge/*`。第三方依赖同时声明在发行包顶层，并固定为源码工作区本次安装实际解析到的版本；发现同一依赖在工作区有不同解析版本时拒绝打包，要求先核对 lockfile。第三方依赖的安装仍需要 npm 网络访问，tarball 并非完整离线安装包。

`test:package` 在临时目录安装 tarball，使用临时 HOME / DATA_DIR 和本地空闲端口：检查两个 bin 的版本和帮助、初始化权限与幂等、内部模块导入、Runner 鉴权与健康版本、Workbench 页面和 JavaScript 静态资源。测试不连接真实机器人，不提交 Agent 任务，最后只关闭自己创建的进程并删除临时目录。

## 版本与变更记录

根 `package.json` 是版本源；内部 workspace 包通过同步脚本保持一致。运行时 `VERSION` 从 core 包自己的 `package.json` 读取，CLI 和 Runner `/health` 不再各自维护版本字符串。

```bash
npm version patch --no-git-tag-version
pnpm version:check
```

`npm version` 的 version 生命周期调用同步脚本，更新所有 workspace 元数据，不自动创建提交或 tag。若手动改根版本，运行 `pnpm version:sync`。同步后更新 `CHANGELOG.md`，重新构建并跑全部检查。

## 公开发布门槛

1. 审查最终 diff，完成 build、lint、全量测试和 `test:package`。
2. 核实 npm 包名及账号权限。正式包名为 `@graychennpm/codebridge`；npm 拒绝无前缀名称 `codebridge`，因为它与已有包 `homebridge` 太相似。若以后改名，需先修改根包名并重新打包验收。
3. 取得对具体包名、版本及外部发布动作的授权。发布凭据由发布者保管，本地构建无需读取 token。
4. 发布者运行下列命令。仅对已验收的 tarball 发布，源码仓库仍保留 `private: true`，防止误把整个仓库上传。

```bash
npm publish /absolute/path/graychennpm-codebridge-0.1.0.tgz --access public
```

Git tag、GitHub Release、推送和本机线上部署是独立动作，不能因为本地打包通过就视为已完成或已授权。每次发布后都应核对 registry 版本和 tarball 完整性，再更新 README 的安装版本。

## 验收状态

见 `docs/plans/2026-10-10-npm-delivery.md` 的 Surface Matrix 与本次交付记录。安装包验收覆盖本地安装与隔离启动；真实通道、真实 Agent 任务、全局安装及后台常驻部署均未在本次测试中操作。

依据：[npm bundleDependencies](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bundledependencies)。
