import { HostedToolError, httpFailure, type JsonResponse } from './http.js'

export type HostedProvider = 'openai-codex' | 'xai'

/** Pi 的 `ctx.modelRegistry` 里本扩展用到的部分。 */
export type ProviderAuthSource = {
  getProviderAuth(provider: string): Promise<{ auth: { apiKey?: string } } | undefined>
}

const LOGIN_HINT: Record<HostedProvider, string> = {
  'openai-codex': '在 Pi 里执行 /login 选 OpenAI (ChatGPT Plus/Pro)，或在 Atrium 里为该身份重新登录 openai-codex',
  xai: '在 Pi 里执行 /login 选 xAI，或配置 XAI_API_KEY'
}

/**
 * 通过 Pi 的公开接口取当前 provider 的令牌。Pi 在令牌临近过期时会在凭据锁内刷新并写回，
 * 所以每次调用都现取、不缓存；刷新失败时 Pi 抛错，这里转成可读原因。
 */
export async function resolveToken(registry: ProviderAuthSource, provider: HostedProvider): Promise<string> {
  let result: Awaited<ReturnType<ProviderAuthSource['getProviderAuth']>>
  try {
    result = await registry.getProviderAuth(provider)
  } catch (error) {
    // Pi 的 ModelsError 把刷新失败放在 message 里（如 "OAuth refresh failed for xai"），不含令牌本身。
    const reason = error instanceof Error ? error.message : String(error)
    throw new HostedToolError(`${provider} 令牌刷新失败（${reason.slice(0, 200)}）。请${LOGIN_HINT[provider]}。`)
  }
  const token = result?.auth.apiKey?.trim()
  if (!token) throw new HostedToolError(`没有 ${provider} 的登录凭据。请${LOGIN_HINT[provider]}。`)
  return token
}

/**
 * 用当前令牌发请求；遇到 401/403 再向 Pi 取一次，若拿到的是另一枚令牌（别处刚刷新过）就重试一次，
 * 否则判定登录失效。令牌只在这里和 send 之间传递，不进结果和报错。
 */
export async function sendWithToken(
  registry: ProviderAuthSource,
  provider: HostedProvider,
  label: string,
  send: (token: string) => Promise<JsonResponse>
): Promise<unknown> {
  let token = await resolveToken(registry, provider)
  const used = [token]
  let response = await send(token)
  if (!response.ok && (response.status === 401 || response.status === 403)) {
    const next = await resolveToken(registry, provider)
    if (next !== token) {
      token = next
      used.push(token)
      response = await send(token)
    }
  }
  if (response.ok) return response.value
  // 服务端可能不带 Bearer 前缀直接回显令牌；按原文抹掉用过的令牌。
  const scrubbed = used.reduce((text, value) => text.split(value).join('[已隐藏]'), response.detail).slice(0, 300)
  if (response.status === 401 || response.status === 403) {
    const detail = scrubbed ? `：${scrubbed}` : ''
    throw new HostedToolError(
      `${label}鉴权失败（HTTP ${response.status}）${detail}。当前 ${provider} 登录可能已失效或无此权限，请${LOGIN_HINT[provider]}。`
    )
  }
  throw httpFailure(label, response.status, scrubbed)
}
