# AGENTS Evolution

## 2026-09-20 · 根包不做 workspaces

- 发生：Atrium 用 `github:liu-zhengdong/pi-atrium` 安装时，npm 因根包声明了 workspaces，即使没有 prepare 也会嵌套 `npm install --include=dev`；本机 npm 12 再叠用户 `allow-scripts` 配置直接 EALLOWSCRIPTS。
- 分析：合集是一个可安装包，adapter/notes 只是目录，不是要单独发布的 workspace。嵌套安装既慢又脆。
- 改变：去掉根 `workspaces`。开发时 adapter 测试用 `npm ci --prefix adapter`。

## 2026-09-20 · 独立仓 pi-atrium 三合一

- 发生：用户确认 Pi 侧（ACP、MCP 代理、notes）收为独立仓，供个人 TUI `pi install git:` 与 Atrium git 依赖共用；`pi install` 只认仓根，不能装 atrium 子目录。
- 分析：刚合入 atrium 的 in-tree 方案解决不了个人 TUI 安装；独立仓重新成为源，产品仓改回依赖。
- 改变：本仓库为 `@liuser/pi-atrium`，内含原 pi-acp 根目录与 `adapter/`、`notes/` workspace。

## 2026-09-20 · 合入 Atrium 仓库

- 发生：Atrium 将本包收为 `packages/pi-acp` workspace，不再从独立 GitHub 仓库安装。
- 分析：独立仓的 git 依赖分发和上游自动同步是为 fork 卫生准备的；合入后接入缺口与产品同一 PR，上游跟进改为在该目录手工合并。
- 改变：开发规范改为在 Atrium 根目录用 workspace 脚本测试／编译；去掉独立 npm 发布前置步骤。

## 2026-09-17 · 同步 MCP 接入后的开发规范

- 发生：交付检查发现上游 AGENTS.md 仍要求拒绝非空 mcpServers，并描述旧版 SDK 接线和未完成的脚手架。
- 分析：这些入口说明与本次实现不符，会误导后续修改；用户已明确要求新增／修改文档默认中文，设计讨论维护在 issue。
- 改变：按当前代码更新中文开发规范，说明固定代理依赖、消息注入、状态所有权与验证边界，移除过时的本地路径和客户端假设。具体设计、实测与取舍见 [追踪 issue #1](https://github.com/liu-zhengdong/pi-acp/issues/1)。

## 2026-09-17 · 通用原进程接入与消息时序

- 发生：用户确认将 Atrium 专属桥接收敛到 pi-acp；联合实测发现忙时 triggerTurn:false 的说明虽然显示在 TUI，但未进入当前模型回合。
- 分析：运行控制属于通用接入层，业务状态属于客户端；原生 Pi 的无触发消息会等到执行结束才追加，传参单测与 UI 展示不足以证明消息到达时序。
- 改变：更新目标、运行控制目录、进程所有权与增量 MCP 范围；验证要求明确核查真实载荷和到达时序。实现区分忙时插入与空闲时免唤醒，事实与证据集中于 issue #7。
