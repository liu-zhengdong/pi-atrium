import { codexTools } from './codex.js'
import { HostedToolError } from './http.js'
import { xaiTools } from './xai.js'
import { DEFAULT_ENDPOINTS, type HostedEndpoints, type HostedTool, type HostedToolContext } from './types.js'

type ModelRef = { provider: string; id: string } | undefined

type RegisteredTool = Omit<HostedTool, 'provider'>

export type HostedToolsApi = {
  registerTool(tool: RegisteredTool): void
  getActiveTools(): string[]
  setActiveTools(names: string[]): void
  on(
    event: 'session_start' | 'before_agent_start',
    handler: (event: unknown, ctx: { model: ModelRef }) => unknown
  ): void
  on(event: 'model_select', handler: (event: { model: ModelRef }, ctx: { model: ModelRef }) => unknown): void
}

/**
 * 只保留当前 provider 的托管工具：其他 provider 的全部移出活动集，其他扩展的工具原样保留。
 * Pi 注册工具时默认激活，所以会话开始时也要同步一次。
 */
export function syncHostedTools(pi: HostedToolsApi, tools: readonly HostedTool[], model: ModelRef): void {
  const hosted = new Set(tools.map(tool => tool.name))
  const wanted = tools.filter(tool => tool.provider === model?.provider).map(tool => tool.name)
  try {
    const active = pi.getActiveTools()
    const next = [...active.filter(name => !hosted.has(name)), ...wanted]
    if (next.length === active.length && next.every((name, index) => name === active[index])) return
    pi.setActiveTools(next)
  } catch {
    // 扩展加载阶段动作方法尚不可用；before_agent_start 会在请求模型前再同步。
  }
}

export function registerHostedTools(pi: HostedToolsApi, endpoints: HostedEndpoints = DEFAULT_ENDPOINTS): void {
  const tools = [...codexTools(endpoints), ...xaiTools(endpoints)]
  for (const { provider, execute, ...tool } of tools) {
    pi.registerTool({
      ...tool,
      execute(toolCallId, params, signal, onUpdate, ctx: HostedToolContext) {
        // 活动集已按 provider 收窄；这里兜住切换模型与工具调用交错的窗口，避免用错账号发请求。
        if (ctx.model?.provider !== provider)
          throw new HostedToolError(`${tool.name} 只在当前模型的 provider 为 ${provider} 时可用，没有发出请求。`)
        return execute(toolCallId, params ?? {}, signal, onUpdate, ctx)
      }
    })
  }
  pi.on('session_start', (_event, ctx) => syncHostedTools(pi, tools, ctx.model))
  pi.on('model_select', (event, ctx) => syncHostedTools(pi, tools, event.model ?? ctx.model))
  pi.on('before_agent_start', (_event, ctx) => syncHostedTools(pi, tools, ctx.model))
}

export default function hostedToolsExtension(pi: HostedToolsApi): void {
  registerHostedTools(pi)
}
