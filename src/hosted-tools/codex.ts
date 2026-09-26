import { randomUUID } from 'node:crypto'
import { sendWithToken } from './auth.js'
import { HostedToolError, isRecord, postJson } from './http.js'
import { readImageInputs, saveGeneratedImage } from './images.js'
import { stringListParam, stringParam, type HostedEndpoints, type HostedTool } from './types.js'

// 请求形状与 pi-better-openai 0.x 对 Codex 后端的用法一致：搜索走 alpha/search，生图走 images/*。
const ORIGINATOR = 'codex_cli_rs'
const USER_AGENT = 'codex_cli_rs/0.0.0 (pi-atrium)'
const SEARCH_MODEL = 'gpt-5.6-luna'
const SEARCH_REASONING_EFFORT = 'max'
const SEARCH_MAX_OUTPUT_TOKENS = 4096
const SEARCH_TIMEOUT_MS = 60_000
const SEARCH_MAX_QUERY_BYTES = 8 * 1024
const SEARCH_MAX_RESPONSE_BYTES = 256 * 1024
const SEARCH_MAX_SOURCES = 10
const IMAGE_MODEL = 'gpt-image-2.5'
const IMAGE_TIMEOUT_MS = 180_000
const IMAGE_MAX_RESPONSE_BYTES = 64 * 1024 * 1024
const IMAGE_MAX_INPUTS = 5
const IMAGE_MAX_INPUT_BYTES = 20 * 1024 * 1024

/** ChatGPT 账号 id 在 access token 的 JWT 里；Pi 的 openai-codex 登录也从这里取。 */
export function chatgptAccountId(token: string): string {
  try {
    const payload = token.split('.')[1]
    if (payload) {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
      const auth = isRecord(claims) ? claims['https://api.openai.com/auth'] : undefined
      const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined
      if (typeof accountId === 'string' && accountId.trim()) return accountId.trim()
    }
  } catch {
    // 落到下面的统一报错。
  }
  throw new HostedToolError('openai-codex 令牌里没有 ChatGPT 账号信息，无法调用 Codex 后端。请重新登录 openai-codex。')
}

function codexHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'chatgpt-account-id': chatgptAccountId(token),
    accept: 'application/json',
    'content-type': 'application/json',
    originator: ORIGINATOR,
    'user-agent': USER_AGENT,
    ...extra
  }
}

type SearchSource = { url: string; title?: string; snippet?: string }

export function parseCodexSearch(value: unknown): { answer: string; sources: SearchSource[] } {
  if (!isRecord(value) || typeof value.output !== 'string')
    throw new HostedToolError('Codex 搜索返回的内容缺少 output 字段，接口可能已变更。')
  const results = Array.isArray(value.results) ? value.results : []
  const sources = results.flatMap((item): SearchSource[] => {
    if (!isRecord(item) || typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url)) return []
    const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : undefined
    const snippet = typeof item.snippet === 'string' && item.snippet.trim() ? item.snippet.trim() : undefined
    return [{ url: item.url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) }]
  })
  return { answer: value.output.trim(), sources }
}

export function formatSearch(query: string, answer: string, sources: SearchSource[]): string {
  const lines = answer ? [answer] : []
  const shown = sources.slice(0, SEARCH_MAX_SOURCES)
  if (shown.length) {
    lines.push('', '来源：')
    shown.forEach((source, index) => {
      lines.push(`${index + 1}. [${source.title ?? source.url}](${source.url})`)
      if (source.snippet) lines.push(`   ${source.snippet}`)
    })
  }
  return lines.length ? lines.join('\n').trim() : `没有找到「${query}」的结果。`
}

export function codexTools(endpoints: HostedEndpoints): HostedTool[] {
  const search: HostedTool = {
    provider: 'openai-codex',
    name: 'codex_search',
    label: 'Codex 搜索',
    description: '用当前 ChatGPT 账号经 Codex 搜索后端联网搜索，返回答案和引用来源。',
    promptSnippet: '联网搜索（ChatGPT 账号）',
    promptGuidelines: [
      '需要最新信息、现价、近期发布或任何可能已变化的事实时，用 codex_search 联网搜索，并在回答里引用返回的来源链接。'
    ],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索问题，尽量保留原话。' }
      },
      required: ['query'],
      additionalProperties: false
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const query = stringParam(params, 'query')
      if (!query) throw new HostedToolError('codex_search 需要非空的 query。')
      if (Buffer.byteLength(query) > SEARCH_MAX_QUERY_BYTES)
        throw new HostedToolError(`query 超过 ${SEARCH_MAX_QUERY_BYTES} 字节。`)
      const label = 'Codex 搜索'
      const value = await sendWithToken(ctx.modelRegistry, 'openai-codex', label, token =>
        postJson({
          label,
          url: `${endpoints.codex}/alpha/search`,
          headers: codexHeaders(token),
          body: {
            id: randomUUID(),
            model: SEARCH_MODEL,
            reasoning: { effort: SEARCH_REASONING_EFFORT },
            input: query,
            commands: { search_query: [{ q: query }], response_length: 'short' },
            settings: { allowed_callers: ['direct'], external_web_access: true },
            max_output_tokens: SEARCH_MAX_OUTPUT_TOKENS
          },
          timeoutMs: SEARCH_TIMEOUT_MS,
          maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES,
          signal
        })
      )
      const { answer, sources } = parseCodexSearch(value)
      return {
        content: [{ type: 'text', text: formatSearch(query, answer, sources) }],
        details: { query, sources }
      }
    }
  }

  const image: HostedTool = {
    provider: 'openai-codex',
    name: 'codex_image',
    label: 'Codex 生图',
    description:
      '用当前 ChatGPT 账号经 Codex Images 接口生成图片；传 images（本地图片路径）则按提示改图或以其为参考。图片保存到工作目录下 .pi/generated-images/，返回保存路径。',
    promptSnippet: '生成或修改图片（ChatGPT 账号）',
    promptGuidelines: [
      '用户要生成或修改位图（插画、照片、图标、贴图等）时用 codex_image；prompt 原样转述用户的描述，不要自行加料。',
      '改图时把用户给的本地图片路径放进 images；结果只返回保存路径，需要查看时再用 read 读取。'
    ],
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '生图或改图的描述，原样转述用户的话。' },
        images: {
          type: 'array',
          maxItems: IMAGE_MAX_INPUTS,
          items: { type: 'string' },
          description: '要修改或作参考的本地图片路径（相对路径按工作目录解析），支持 png/jpg/webp/gif。不传则直接生成。'
        }
      },
      required: ['prompt'],
      additionalProperties: false
    },
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const prompt = stringParam(params, 'prompt')
      if (!prompt) throw new HostedToolError('codex_image 需要非空的 prompt。')
      const paths = stringListParam(params, 'images')
      if (params.images !== undefined && !paths) throw new HostedToolError('images 必须是字符串数组。')
      const inputs = await readImageInputs(paths, ctx.cwd, {
        maxCount: IMAGE_MAX_INPUTS,
        maxBytes: IMAGE_MAX_INPUT_BYTES,
        accept: ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
      })
      const action = inputs.length ? 'edit' : 'generate'
      const common = { prompt, background: 'auto', model: IMAGE_MODEL, quality: 'auto', size: 'auto' }
      const body =
        action === 'edit' ? { images: inputs.map(input => ({ image_url: input.dataUrl })), ...common } : common
      const label = action === 'edit' ? 'Codex 改图' : 'Codex 生图'
      onUpdate?.({ content: [{ type: 'text', text: `${label}请求中（${IMAGE_MODEL}）…` }], details: {} })
      const value = await sendWithToken(ctx.modelRegistry, 'openai-codex', label, token =>
        postJson({
          label,
          url: `${endpoints.codex}/images/${action === 'edit' ? 'edits' : 'generations'}`,
          headers: codexHeaders(token, { 'x-codex-image-turn-id': randomUUID() }),
          body,
          timeoutMs: IMAGE_TIMEOUT_MS,
          maxResponseBytes: IMAGE_MAX_RESPONSE_BYTES,
          signal
        })
      )
      const images = isRecord(value) && Array.isArray(value.data) ? value.data : []
      const first = images.find(item => isRecord(item) && typeof item.b64_json === 'string' && item.b64_json.trim())
      if (!isRecord(first)) throw new HostedToolError(`${label}没有返回图片数据。`)
      const savedPath = await saveGeneratedImage(ctx.cwd, 'codex-image', first.b64_json as string)
      const revisedPrompt = typeof first.revised_prompt === 'string' ? first.revised_prompt : undefined
      const lines = [`已保存：${savedPath}`, `模型：${IMAGE_MODEL}（${action === 'edit' ? '改图' : '生成'}）`]
      if (revisedPrompt) lines.push(`改写后的提示：${revisedPrompt}`)
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { savedPath, model: IMAGE_MODEL, action, inputs: inputs.map(input => input.path) }
      }
    }
  }

  return [search, image]
}
