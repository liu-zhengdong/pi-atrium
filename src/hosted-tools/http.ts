/** 托管工具的失败都走这个类型：消息直接给模型看，必须说清原因且不含令牌。 */
export class HostedToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostedToolError'
  }
}

export type JsonRequest = {
  /** 出现在报错里的服务名，如「Codex 搜索」。 */
  label: string
  url: string
  headers: Record<string, string>
  body: unknown
  timeoutMs: number
  maxResponseBytes: number
  signal?: AbortSignal
}

export type JsonResponse = { ok: true; value: unknown } | { ok: false; status: number; detail: string }

/**
 * 发一个 JSON POST，返回解析后的正文或 HTTP 失败。401/403 交给调用方决定是否换令牌重试，
 * 所以这里不抛；网络、超时、取消、超长和非 JSON 直接抛出可读的 HostedToolError。
 */
export async function postJson(request: JsonRequest): Promise<JsonResponse> {
  const timeout = AbortSignal.timeout(request.timeoutMs)
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
      redirect: 'error',
      credentials: 'omit'
    })
  } catch (error) {
    if (request.signal?.aborted) throw new HostedToolError(`${request.label}已取消。`)
    if (timeout.aborted)
      throw new HostedToolError(`${request.label}超时（${Math.round(request.timeoutMs / 1000)} 秒）。`)
    throw new HostedToolError(`${request.label}请求失败：${networkReason(error)}。请检查网络后重试。`)
  }

  let text: string
  try {
    text = await readBounded(response, request.maxResponseBytes)
  } catch (error) {
    if (error instanceof HostedToolError) throw new HostedToolError(`${request.label}${error.message}`)
    if (request.signal?.aborted) throw new HostedToolError(`${request.label}已取消。`)
    if (timeout.aborted)
      throw new HostedToolError(`${request.label}超时（${Math.round(request.timeoutMs / 1000)} 秒）。`)
    throw new HostedToolError(`${request.label}读取响应失败：${networkReason(error)}。`)
  }

  if (!response.ok) return { ok: false, status: response.status, detail: errorDetail(text) }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    throw new HostedToolError(`${request.label}返回的不是 JSON（HTTP ${response.status}）。`)
  }
}

/** 把非 2xx 响应转成给模型看的原因；401/403 由调用方先处理。 */
export function httpFailure(label: string, status: number, detail: string): HostedToolError {
  const suffix = detail ? `：${detail}` : ''
  if (status === 429) return new HostedToolError(`${label}被限流或额度用尽（HTTP 429）${suffix}。稍后再试。`)
  if (status >= 500) return new HostedToolError(`${label}服务端出错（HTTP ${status}）${suffix}。稍后再试。`)
  return new HostedToolError(`${label}失败（HTTP ${status}）${suffix}。`)
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new HostedToolError(`响应超过 ${maxBytes} 字节上限。`)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new HostedToolError(`响应超过 ${maxBytes} 字节上限。`)
      }
      chunks.push(item.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 取服务端错误说明（调用方截到 300 字）；OpenAI/xAI 都用 `{ error: { message } }` 或 `{ error: "..." }`。 */
function errorDetail(text: string): string {
  let message = text
  try {
    const parsed = JSON.parse(text) as unknown
    if (isRecord(parsed)) {
      const error = parsed.error
      if (typeof error === 'string') message = error
      else if (isRecord(error) && typeof error.message === 'string') message = error.message
      else if (typeof parsed.detail === 'string') message = parsed.detail
      else if (typeof parsed.message === 'string') message = parsed.message
    }
  } catch {
    // 非 JSON 错误页按原文截断。
  }
  // 截断留给调用方：先按原文抹掉令牌再截，免得截断处留下半枚令牌。
  return redactBearer(message.replace(/\s+/g, ' ').trim()).slice(0, 64 * 1024)
}

function networkReason(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined
  const message = cause ?? (error instanceof Error ? error.message : String(error))
  return redactBearer(message).slice(0, 200)
}

/** 服务端偶尔回显请求头；不让任何 Bearer 串进模型上下文。 */
function redactBearer(text: string): string {
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
