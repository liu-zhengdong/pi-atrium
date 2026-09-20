# pi-atrium 开发规范

## 目标与结构

本仓库是 Atrium 的 Pi 侧合集，也是可独立安装的 Pi 包：`pi install git:github.com/liu-zhengdong/pi-atrium`。不修改 Pi 核心。聊天、任务和事件订阅仍由 Atrium 产品负责。

一份安装同时提供：

- 根目录：ACP 适配器、命名身份、运行时发现（原 `pi-acp`）。CLI 仍为 `pi-acp`。
- `adapter/`：MCP 固定代理（原 `pi-mcp-adapter`）。
- `notes/`：Markdown 笔记渐进披露（原 `pi-notes`）。

`package.json` 的 `pi.extensions` 按该顺序加载。接入缺口在本仓库补齐；Atrium 以 git 依赖消费，不在产品仓再放一份源码。

- `src/acp/app.ts`：使用 `@agentclientprotocol/sdk` builder API 注册 ACP 请求入口。
- `src/acp/`：处理协议、会话生命周期、权限及对外事件。
- `src/pi-rpc/`：管理 Pi 子进程、RPC 请求、内部扩展及 MCP 注册桥接。
- `src/runtime/`：通用 Pi 扩展、私有本机 IPC、实例发现与连接级运行控制。
- 标准 ACP 会话对应托管 RPC 子进程；原地接入使用独立的能力协商和实例／代际标识。接入不转移 TUI 进程所有权，断开不能终止用户终端。

## MCP 接入边界

- `session/new`、`session/load`、`session/resume` 可携带 stdio、Streamable HTTP、SSE 服务描述；在原始请求边界校验，避免 SDK 丢弃无效项后静默降级。
- 非空服务列表要求本包 `adapter/` 返回 `toolExposure: "proxy-only"`。带 MCP 的新子进程在启动时选择固定代理模式；空列表不强制依赖 MCP 扩展。
- 业务工具经固定代理发现和调用；使用说明追加到后续上下文，不把业务工具新增到模型 `tools`，不改写 system prompt。
- 保留原有服务，名称冲突拒绝，失败回滚，只释放桥接持有的注册。关闭／删除会话时清理内存中的服务描述。
- 不新增自有 MCP 配置存储；连接凭据不加入模型消息。上游既有 Session 映射和 adapter 元数据缓存仍存在。
- `runtime/v1` 提供运行中增量新增，忙时不替换或移除现有服务；已接入服务的目录变化沿用 MCP 通知机制。

## 实现约束

- Pi 自行执行本地文件和终端操作，不新增 ACP 客户端文件／终端委派。
- 使用小型转换函数连接 Pi 事件与 ACP 更新，并保留流式输出、取消和子进程清理的测试。
- 异常路径明确失败，不把部分能力可用表述为请求完整成功。
- 优先明确类型，避免 `any`。注释解释不明显的设计原因，不复述代码。
- 根目录不要加 `prepare` / `prepack` / `install` 生命周期脚本，以便 `pi install git:` 和 npm git 依赖可安装。`dist/` 入库；构建脚本叫 `compile`。

## 开发与验证

```bash
npm test
npm run compile
```

`npm ci` 之后还要 `npm ci --prefix adapter`。根 devDependencies 带 notes 测试所需的 Pi 包；adapter 的 CLI 测试依赖已入库的 `adapter/dist/`；interactive-visualizer 用例要先 `npm run --prefix adapter/examples/interactive-visualizer build`。然后 `npm test`（ACP、adapter、notes）。`npm run validate` 含格式、类型、lint、测试和构建。修改 `src/` 后编译并核对 `dist/`。根 `package.json` 不要加 `workspaces`：git 依赖会因此跑嵌套 `npm install`。adapter 与 notes 保持各自目录内的格式和测试入口，根目录 prettier/eslint 不改它们。

原进程联调使用 `npm run smoke:runtime`。消息与使用说明须检查实际模型载荷和到达时序，不能以 TUI 已显示代替当前回合已可见；Pi 的 `triggerTurn:false` 忙时行为须以原生入口验证。

MCP 联调使用 `npm run smoke:mcp`，默认加载本仓库 `adapter/index.ts`。该入口使用真实 Pi 与临时配置及本地模型夹具；检查工具往返、坏输入、完整工具定义、上下文和恢复，不代表真实模型自主行为的质量验收。

## 协作与交付

- 按用户授权提交代码；变更关联追踪 issue，通过 PR 审阅。设计讨论和工作进度维护在 issue/PR，正式使用说明维护在 README。
- issue、PR 说明和新增／修改文档默认中文；代码标识、命令及协议字段保持准确原文。
- 交付说明区分本地验证、远端 CI 和未覆盖范围。
