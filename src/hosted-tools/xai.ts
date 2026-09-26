import { sendWithToken } from './auth.js'
import { HostedToolError, isRecord, postJson } from './http.js'
import { readImageInputs, saveGeneratedImage } from './images.js'
import { stringListParam, stringParam, type HostedEndpoints, type HostedTool, type HostedToolContext } from './types.js'

// 搜索另发一个 Responses 请求并只挂一个服务端工具（web_search / x_search），与 pi-xai-oauth 的做法一致；
// 生图直连 images/generations 与 images/edits，要 b64_json 以便落盘。
const USER_AGENT = 'pi-atrium'
const SEARCH_TIMEOUT_MS = 120_000
const SEARCH_MAX_RESPONSE_BYTES = 1024 * 1024
const SEARCH_MAX_QUERY_CHARS = 4_000
const IMAGE_MODEL = 'grok-imagine-image-2.0'
const IMAGE_TIMEOUT_MS = 180_000
const IMAGE_MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const IMAGE_MAX_INPUTS = 3
const IMAGE_MAX_INPUT_BYTES = 8 * 1024 * 1024
const MAX_ALLOWED_DOMAINS = 5
const MAX_X_HANDLES = 10
export const XAI_ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '2:1',
  '1:2',
  '19.5:9',
  '9:19.5',
  '20:9',
  '9:20',
  'auto'
] as const

function xaiHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': USER_AGENT
  }
}

type Citation = { url: string; title?: string }

/** 取 Responses 的正文和引用：正文在 output_text 或 message.content[].text，引用在 annotations 或顶层 citations。 */
export function parseResponsesSearch(value: unknown): { text: string; citations: Citation[] } {
  if (!isRecord(value)) throw new HostedToolError('xAI 搜索返回的内容不是对象，接口可能已变更。')
  const chunks: string[] = []
  const citations = new Map<string, Citation>()
  const cite = (url: unknown, title?: unknown) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || citations.has(url)) return
    citations.set(url, { url, ...(typeof title === 'string' && title.trim() ? { title: title.trim() } : {}) })
  }
  for (const item of Array.isArray(value.output) ? value.output : []) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (!isRecord(part)) continue
      if (part.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text)
      for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
        if (isRecord(annotation) && annotation.type === 'url_citation') cite(annotation.url, annotation.title)
      }
    }
  }
  for (const url of Array.isArray(value.citations) ? value.citations : []) cite(url)
  const text = (typeof value.output_text === 'string' && value.output_text ? value.output_text : chunks.join('')).trim()
  return { text, citations: [...citations.values()] }
}

function formatCitations(text: string, citations: Citation[], empty: string): string {
  const lines = text ? [text] : [empty]
  if (citations.length) {
    lines.push('', '来源：')
    citations.slice(0, 20).forEach((citation, index) => {
      lines.push(`${index + 1}. [${citation.title ?? citation.url}](${citation.url})`)
    })
  }
  return lines.join('\n')
}

/** 搜索用当前对话的 Grok 模型发请求；切到别的 provider 时工具已被移除，这里再兜一次。 */
function searchModel(ctx: HostedToolContext, toolName: string): string {
  if (ctx.model?.provider !== 'xai' || !ctx.model.id)
    throw new HostedToolError(`${toolName} 只在当前模型为 xai 时可用，没有发出请求。`)
  return ctx.model.id
}

async function runSearch(
  endpoints: HostedEndpoints,
  ctx: HostedToolContext,
  label: string,
  model: string,
  prompt: string,
  tool: Record<string, unknown>,
  signal: AbortSignal | undefined
) {
  const value = await sendWithToken(ctx.modelRegistry, 'xai', label, token =>
    postJson({
      label,
      url: `${endpoints.xai}/responses`,
      headers: xaiHeaders(token),
      body: { model, input: [{ role: 'user', content: prompt }], tools: [tool], store: false },
      timeoutMs: SEARCH_TIMEOUT_MS,
      maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES,
      signal
    })
  )
  return parseResponsesSearch(value)
}

function dateParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = stringParam(params, key)
  if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HostedToolError(`${key} 须为 YYYY-MM-DD。`)
  return value
}

function queryParam(params: Record<string, unknown>, toolName: string): string {
  const query = stringParam(params, 'query')
  if (!query) throw new HostedToolError(`${toolName} 需要非空的 query。`)
  if (query.length > SEARCH_MAX_QUERY_CHARS) throw new HostedToolError(`query 超过 ${SEARCH_MAX_QUERY_CHARS} 字。`)
  return query
}

function boundedList(params: Record<string, unknown>, key: string, max: number): string[] | undefined {
  const list = stringListParam(params, key)
  if (params[key] !== undefined && !list) throw new HostedToolError(`${key} 必须是字符串数组。`)
  const cleaned = list?.map(item => item.trim()).filter(Boolean)
  if (cleaned && cleaned.length > max) throw new HostedToolError(`${key} 最多 ${max} 项。`)
  return cleaned?.length ? cleaned : undefined
}

export function xaiTools(endpoints: HostedEndpoints): HostedTool[] {
  const webSearch: HostedTool = {
    provider: 'xai',
    name: 'xai_web_search',
    label: 'xAI 联网搜索',
    description: '用当前 xAI 账号另发一次 Grok 请求，借服务端 web_search 联网搜索，返回摘要和来源。',
    promptSnippet: '联网搜索（xAI 账号）',
    promptGuidelines: ['需要最新信息或可能已变化的事实时，用 xai_web_search 联网搜索，并在回答里引用返回的来源链接。'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索问题，尽量保留原话。' },
        allowed_domains: {
          type: 'array',
          maxItems: MAX_ALLOWED_DOMAINS,
          items: { type: 'string' },
          description: '只在这些域名内搜索（可选，最多 5 个）。'
        }
      },
      required: ['query'],
      additionalProperties: false
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const model = searchModel(ctx, 'xai_web_search')
      const query = queryParam(params, 'xai_web_search')
      const domains = boundedList(params, 'allowed_domains', MAX_ALLOWED_DOMAINS)
      const tool = { type: 'web_search', ...(domains ? { filters: { allowed_domains: domains } } : {}) }
      const prompt = `Search the web for: ${query}\n\nSummarize the key results and cite sources.`
      const result = await runSearch(endpoints, ctx, 'xAI 联网搜索', model, prompt, tool, signal)
      return {
        content: [
          { type: 'text', text: formatCitations(result.text, result.citations, `没有找到「${query}」的结果。`) }
        ],
        details: { query, model, citations: result.citations }
      }
    }
  }

  const xSearch: HostedTool = {
    provider: 'xai',
    name: 'xai_x_search',
    label: 'X 搜索',
    description: '用当前 xAI 账号另发一次 Grok 请求，借服务端 x_search 搜索 X（Twitter）帖子，返回摘要和帖子链接。',
    promptSnippet: '搜索 X 帖子（xAI 账号）',
    promptGuidelines: ['需要 X（Twitter）上的实时讨论、帖子或某账号动态时用 xai_x_search。'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要在 X 上找什么。' },
        from_date: { type: 'string', description: '只看此日期之后的帖子，YYYY-MM-DD（可选）。' },
        to_date: { type: 'string', description: '只看此日期之前的帖子，YYYY-MM-DD（可选）。' },
        handles: {
          type: 'array',
          maxItems: MAX_X_HANDLES,
          items: { type: 'string' },
          description: '只看这些账号的帖子，不带 @（可选，最多 10 个）。'
        }
      },
      required: ['query'],
      additionalProperties: false
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const model = searchModel(ctx, 'xai_x_search')
      const query = queryParam(params, 'xai_x_search')
      const fromDate = dateParam(params, 'from_date')
      const toDate = dateParam(params, 'to_date')
      const handles = boundedList(params, 'handles', MAX_X_HANDLES)?.map(handle => handle.replace(/^@/, ''))
      const tool = {
        type: 'x_search',
        ...(fromDate ? { from_date: fromDate } : {}),
        ...(toDate ? { to_date: toDate } : {}),
        ...(handles ? { allowed_x_handles: handles } : {})
      }
      const prompt = `Search X for: ${query}\n\nSummarize the most relevant posts with usernames, timestamps and links.`
      const result = await runSearch(endpoints, ctx, 'X 搜索', model, prompt, tool, signal)
      return {
        content: [
          { type: 'text', text: formatCitations(result.text, result.citations, `X 上没有找到「${query}」的结果。`) }
        ],
        details: { query, model, citations: result.citations }
      }
    }
  }

  const image: HostedTool = {
    provider: 'xai',
    name: 'xai_image',
    label: 'xAI 生图',
    description:
      '用当前 xAI 账号经 Grok Imagine 生成图片；传 images（本地 png/jpg 路径，最多 3 张）则按提示改图。图片保存到工作目录下 .pi/generated-images/，返回保存路径。',
    promptSnippet: '生成或修改图片（xAI 账号）',
    promptGuidelines: [
      '用户要生成或修改位图时用 xai_image；prompt 原样转述用户的描述，不要自行加料。',
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
          description: '要修改的本地图片路径（相对路径按工作目录解析），png/jpg，最多 3 张。不传则直接生成。'
        },
        aspect_ratio: {
          type: 'string',
          enum: [...XAI_ASPECT_RATIOS],
          description: '画幅比例（可选）；多张参考图时默认 auto。'
        }
      },
      required: ['prompt'],
      additionalProperties: false
    },
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const prompt = stringParam(params, 'prompt')
      if (!prompt) throw new HostedToolError('xai_image 需要非空的 prompt。')
      const aspectRatio = stringParam(params, 'aspect_ratio')
      if (aspectRatio && !(XAI_ASPECT_RATIOS as readonly string[]).includes(aspectRatio))
        throw new HostedToolError(`aspect_ratio 只能是 ${XAI_ASPECT_RATIOS.join(' / ')}。`)
      const paths = stringListParam(params, 'images')
      if (params.images !== undefined && !paths) throw new HostedToolError('images 必须是字符串数组。')
      const inputs = await readImageInputs(paths, ctx.cwd, {
        maxCount: IMAGE_MAX_INPUTS,
        maxBytes: IMAGE_MAX_INPUT_BYTES,
        accept: ['image/png', 'image/jpeg']
      })
      const action = inputs.length ? 'edit' : 'generate'
      const body: Record<string, unknown> = { model: IMAGE_MODEL, prompt, n: 1, response_format: 'b64_json' }
      if (action === 'edit') {
        body.resolution = '1k'
        if (inputs.length === 1) {
          body.image = { url: inputs[0]!.dataUrl }
          if (aspectRatio) body.aspect_ratio = aspectRatio
        } else {
          body.images = inputs.map(input => ({ url: input.dataUrl }))
          body.aspect_ratio = aspectRatio ?? 'auto'
        }
      } else if (aspectRatio) {
        body.aspect_ratio = aspectRatio
      }
      const label = action === 'edit' ? 'xAI 改图' : 'xAI 生图'
      onUpdate?.({ content: [{ type: 'text', text: `${label}请求中（${IMAGE_MODEL}）…` }], details: {} })
      const value = await sendWithToken(ctx.modelRegistry, 'xai', label, token =>
        postJson({
          label,
          url: `${endpoints.xai}/images/${action === 'edit' ? 'edits' : 'generations'}`,
          headers: xaiHeaders(token),
          body,
          timeoutMs: IMAGE_TIMEOUT_MS,
          maxResponseBytes: IMAGE_MAX_RESPONSE_BYTES,
          signal
        })
      )
      const data = isRecord(value) && Array.isArray(value.data) ? value.data : []
      const first = data.find(item => isRecord(item) && typeof item.b64_json === 'string' && item.b64_json.trim())
      if (!isRecord(first)) throw new HostedToolError(`${label}没有返回图片数据。`)
      const savedPath = await saveGeneratedImage(ctx.cwd, 'xai-image', first.b64_json as string)
      const revisedPrompt = typeof first.revised_prompt === 'string' ? first.revised_prompt : undefined
      const lines = [`已保存：${savedPath}`, `模型：${IMAGE_MODEL}（${action === 'edit' ? '改图' : '生成'}）`]
      if (revisedPrompt) lines.push(`改写后的提示：${revisedPrompt}`)
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { savedPath, model: IMAGE_MODEL, action, inputs: inputs.map(input => input.path) }
      }
    }
  }

  return [webSearch, xSearch, image]
}
