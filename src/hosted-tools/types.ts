import type { HostedProvider, ProviderAuthSource } from './auth.js'

/** Pi 工具上下文里本扩展用到的部分。 */
export type HostedToolContext = {
  cwd: string
  model: { provider: string; id: string } | undefined
  modelRegistry: ProviderAuthSource
}

export type HostedToolResult = {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, unknown>
}

/** 与 Pi `registerTool` 的形状一致；参数用普通 JSON Schema，不引入 TypeBox 运行时。 */
export type HostedTool = {
  provider: HostedProvider
  name: string
  label: string
  description: string
  promptSnippet: string
  promptGuidelines: string[]
  parameters: Record<string, unknown>
  executionMode?: 'sequential' | 'parallel'
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: HostedToolResult) => void) | undefined,
    ctx: HostedToolContext
  ): Promise<HostedToolResult>
}

/** 生产环境的真实端点；测试把它们指向本地假服务。 */
export type HostedEndpoints = {
  /** 到 `/backend-api/codex` 为止，搜索和生图路径拼在后面。 */
  codex: string
  /** 到 `/v1` 为止。 */
  xai: string
}

export const DEFAULT_ENDPOINTS: HostedEndpoints = {
  codex: 'https://chatgpt.com/backend-api/codex',
  xai: 'https://api.x.ai/v1'
}

export function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function stringListParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return undefined
  return value as string[]
}
