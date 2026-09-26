import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import { registerHostedTools, type HostedToolsApi } from '../../src/hosted-tools/extension.js'
import { IMAGE_OUTPUT_DIR } from '../../src/hosted-tools/images.js'
import type { HostedToolContext, HostedToolResult } from '../../src/hosted-tools/types.js'

process.env.PI_OFFLINE = '1'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])

function codexJwt(accountId: string, nonce: string): string {
  const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: accountId }, nonce }
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
}

type Captured = { method: string; path: string; headers: IncomingMessage['headers']; body: Record<string, any> }
type Reply = { status?: number; json?: unknown; text?: string }

/** 本地假服务：记录每个请求，按 `METHOD /path` 查队列回应。 */
class FakeService {
  readonly requests: Captured[] = []
  private readonly replies = new Map<string, Array<(request: Captured) => Reply>>()
  private server!: Server
  base = ''

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const captured: Captured = {
          method: req.method ?? '',
          path: req.url ?? '',
          headers: req.headers,
          body: raw ? JSON.parse(raw) : {}
        }
        this.requests.push(captured)
        const queue = this.replies.get(`${captured.method} ${captured.path}`) ?? []
        const reply = queue.length > 1 ? queue.shift()!(captured) : queue[0]?.(captured)
        const status = reply?.status ?? (reply ? 200 : 404)
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(reply?.text ?? JSON.stringify(reply?.json ?? { error: { message: 'no fake route' } }))
      })
    })
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    this.base = `http://127.0.0.1:${address.port}`
  }

  on(route: string, ...replies: Array<(request: Captured) => Reply>): void {
    this.replies.set(route, replies)
  }

  reset(): void {
    this.requests.length = 0
    this.replies.clear()
  }

  stop(): Promise<void> {
    return new Promise(resolve => this.server.close(() => resolve()))
  }
}

type Handler = (event: any, ctx: any) => unknown

/** 最小 Pi：记录注册的工具和活动集，事件按名分发。 */
function fakePi(initialActive: string[] = ['read', 'bash', 'mcp']) {
  const tools = new Map<string, Parameters<HostedToolsApi['registerTool']>[0]>()
  const handlers = new Map<string, Handler[]>()
  let active = [...initialActive]
  let loading = true
  const api = {
    registerTool(tool: Parameters<HostedToolsApi['registerTool']>[0]) {
      tools.set(tool.name, tool)
      active.push(tool.name)
    },
    getActiveTools() {
      if (loading) throw new Error('Action methods cannot be called during extension loading')
      return [...active]
    },
    setActiveTools(names: string[]) {
      active = [...names]
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    }
  } as HostedToolsApi
  return {
    api,
    tools,
    active: () => active,
    loaded() {
      loading = false
    },
    async emit(event: string, payload: unknown, ctx: unknown) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx)
    }
  }
}

function staticRegistry(tokens: Record<string, string | string[] | undefined>) {
  const calls: string[] = []
  return {
    calls,
    getProviderAuth: async (provider: string) => {
      calls.push(provider)
      const value = tokens[provider]
      const token = Array.isArray(value) ? (value.length > 1 ? value.shift() : value[0]) : value
      return token ? { auth: { apiKey: token } } : undefined
    }
  }
}

const service = new FakeService()
let pi: ReturnType<typeof fakePi>

test.before(async () => {
  await service.start()
  pi = fakePi()
  registerHostedTools(pi.api, { codex: `${service.base}/backend-api/codex`, xai: `${service.base}/v1` })
})

test.after(() => service.stop())

test.beforeEach(() => service.reset())

function ctxFor(provider: string, registry: HostedToolContext['modelRegistry'], cwd = tmpCwd()): HostedToolContext {
  return { cwd, model: { provider, id: provider === 'xai' ? 'grok-4.6' : 'gpt-5.5' }, modelRegistry: registry }
}

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'hosted-tools-'))
}

async function run(name: string, params: Record<string, unknown>, ctx: HostedToolContext): Promise<HostedToolResult> {
  const tool = pi.tools.get(name)
  assert.ok(tool, name)
  return tool.execute('call-1', params, undefined, undefined, ctx)
}

const HOSTED = ['codex_search', 'codex_image', 'xai_web_search', 'xai_x_search', 'xai_image']

test('活动工具跟随 provider：codex→xai→kimi→codex，其他扩展的工具保留', async () => {
  // 扩展加载期动作方法不可用，同步静默跳过而不是抛错。
  await pi.emit('session_start', { type: 'session_start' }, { model: { provider: 'openai-codex', id: 'gpt-5.5' } })
  assert.deepEqual(pi.active(), ['read', 'bash', 'mcp', ...HOSTED])
  pi.loaded()

  const hosted = () => pi.active().filter(name => HOSTED.includes(name))
  const others = () => pi.active().filter(name => !HOSTED.includes(name))

  await pi.emit('session_start', { type: 'session_start' }, { model: { provider: 'openai-codex', id: 'gpt-5.5' } })
  assert.deepEqual(hosted(), ['codex_search', 'codex_image'])

  await pi.emit('model_select', { model: { provider: 'xai', id: 'grok-4.6' } }, { model: undefined })
  assert.deepEqual(hosted(), ['xai_web_search', 'xai_x_search', 'xai_image'])

  await pi.emit('model_select', { model: { provider: 'kimi-coding', id: 'kimi-k2' } }, { model: undefined })
  assert.deepEqual(hosted(), [])

  await pi.emit('model_select', { model: { provider: 'openai-codex', id: 'gpt-5.5' } }, { model: undefined })
  assert.deepEqual(hosted(), ['codex_search', 'codex_image'])

  // 插件自己的 xai-auth 不算 xai。
  await pi.emit('before_agent_start', {}, { model: { provider: 'xai-auth', id: 'grok-4.6' } })
  assert.deepEqual(hosted(), [])
  assert.deepEqual(others(), ['read', 'bash', 'mcp'])
})

test('工具在不匹配的 provider 下被调用时拒绝，不发请求', async () => {
  const registry = staticRegistry({ 'openai-codex': codexJwt('acct', 'a'), xai: 'xai-token' })
  for (const [name, provider] of [
    ['codex_search', 'kimi-coding'],
    ['codex_image', 'xai'],
    ['xai_web_search', 'openai-codex'],
    ['xai_image', 'xai-auth']
  ]) {
    await assert.rejects(run(name, { query: 'q', prompt: 'p' }, ctxFor(provider, registry)), /没有发出请求/)
  }
  assert.equal(service.requests.length, 0)
  assert.deepEqual(registry.calls, [])
})

test('codex_search 请求形状与结果格式', async () => {
  const token = codexJwt('acct-123', 'search')
  service.on('POST /backend-api/codex/alpha/search', () => ({
    json: {
      output: 'Pi 0.85 已发布。',
      results: [
        { type: 'text_result', url: 'https://example.com/pi', title: 'Pi 发布', snippet: '摘要' },
        { type: 'text_result', url: 'javascript:alert(1)', title: '坏链接' }
      ]
    }
  }))
  const result = await run(
    'codex_search',
    { query: 'Pi 最新版本' },
    ctxFor('openai-codex', staticRegistry({ 'openai-codex': token }))
  )
  const [request] = service.requests
  assert.equal(request.headers.authorization, `Bearer ${token}`)
  assert.equal(request.headers['chatgpt-account-id'], 'acct-123')
  assert.equal(request.headers.originator, 'codex_cli_rs')
  assert.equal(request.body.input, 'Pi 最新版本')
  assert.deepEqual(request.body.commands, { search_query: [{ q: 'Pi 最新版本' }], response_length: 'short' })
  assert.deepEqual(request.body.settings, { allowed_callers: ['direct'], external_web_access: true })
  assert.equal(typeof request.body.model, 'string')
  assert.equal(typeof request.body.id, 'string')
  const text = result.content[0]!.text
  assert.match(text, /Pi 0\.85 已发布。/)
  assert.match(text, /1\. \[Pi 发布\]\(https:\/\/example\.com\/pi\)/)
  assert.doesNotMatch(text, /javascript:/)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token.replace(/\./g, '\\.')))
})

test('codex_image 生成：请求 generations 并把图片存到工作目录', async () => {
  const cwd = tmpCwd()
  service.on('POST /backend-api/codex/images/generations', () => ({
    json: { data: [{ b64_json: PNG.toString('base64'), revised_prompt: '一只猫' }] }
  }))
  const result = await run(
    'codex_image',
    { prompt: '猫' },
    ctxFor('openai-codex', staticRegistry({ 'openai-codex': codexJwt('acct', 'img') }), cwd)
  )
  const [request] = service.requests
  assert.deepEqual(request.body, {
    prompt: '猫',
    background: 'auto',
    model: 'gpt-image-2.5',
    quality: 'auto',
    size: 'auto'
  })
  assert.equal(typeof request.headers['x-codex-image-turn-id'], 'string')
  const savedPath = result.details.savedPath as string
  assert.equal(dirname(savedPath), join(cwd, IMAGE_OUTPUT_DIR))
  assert.match(savedPath, /codex-image-.*\.png$/)
  assert.deepEqual(readFileSync(savedPath), PNG)
  assert.match(result.content[0]!.text, new RegExp(`已保存：${savedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})

test('codex_image 改图：本地图片作为 data URL 发往 edits；坏输入不发请求', async () => {
  const cwd = tmpCwd()
  writeFileSync(join(cwd, 'in.png'), PNG)
  writeFileSync(join(cwd, 'fake.png'), 'not an image')
  const registry = staticRegistry({ 'openai-codex': codexJwt('acct', 'edit') })
  service.on('POST /backend-api/codex/images/edits', () => ({ json: { data: [{ b64_json: PNG.toString('base64') }] } }))
  const result = await run(
    'codex_image',
    { prompt: '加帽子', images: ['in.png'] },
    ctxFor('openai-codex', registry, cwd)
  )
  const [request] = service.requests
  assert.deepEqual(request.body.images, [{ image_url: `data:image/png;base64,${PNG.toString('base64')}` }])
  assert.equal(result.details.action, 'edit')

  service.reset()
  await assert.rejects(
    run('codex_image', { prompt: 'x', images: ['fake.png'] }, ctxFor('openai-codex', registry, cwd)),
    /不支持的图片格式.*fake\.png/
  )
  await assert.rejects(
    run('codex_image', { prompt: 'x', images: ['missing.png'] }, ctxFor('openai-codex', registry, cwd)),
    /图片不存在.*missing\.png/
  )
  await assert.rejects(run('codex_image', { prompt: '  ' }, ctxFor('openai-codex', registry, cwd)), /非空的 prompt/)
  assert.equal(service.requests.length, 0)
})

test('xai_web_search 另发 Responses 请求，只挂 web_search，引用去重', async () => {
  service.on('POST /v1/responses', () => ({
    json: {
      output: [
        { type: 'web_search_call' },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: '答案',
              annotations: [{ type: 'url_citation', url: 'https://a.example', title: 'A' }]
            }
          ]
        }
      ],
      citations: ['https://a.example', 'https://b.example']
    }
  }))
  const result = await run(
    'xai_web_search',
    { query: '天气', allowed_domains: ['example.com'] },
    ctxFor('xai', staticRegistry({ xai: 'xai-token-1' }))
  )
  const [request] = service.requests
  assert.equal(request.headers.authorization, 'Bearer xai-token-1')
  assert.equal(request.body.model, 'grok-4.6')
  assert.equal(request.body.store, false)
  assert.deepEqual(request.body.tools, [{ type: 'web_search', filters: { allowed_domains: ['example.com'] } }])
  assert.match(request.body.input[0].content, /天气/)
  assert.match(
    result.content[0]!.text,
    /^答案\n\n来源：\n1\. \[A\]\(https:\/\/a\.example\)\n2\. \[https:\/\/b\.example\]/
  )
})

test('xai_x_search 挂 x_search 并带日期和账号过滤；坏日期不发请求', async () => {
  service.on('POST /v1/responses', () => ({ json: { output_text: '帖子摘要' } }))
  const ctx = ctxFor('xai', staticRegistry({ xai: 'xai-token-1' }))
  const result = await run(
    'xai_x_search',
    { query: 'pi agent', from_date: '2026-09-01', to_date: '2026-09-26', handles: ['@badlogicgames'] },
    ctx
  )
  assert.deepEqual(service.requests[0]!.body.tools, [
    { type: 'x_search', from_date: '2026-09-01', to_date: '2026-09-26', allowed_x_handles: ['badlogicgames'] }
  ])
  assert.equal(result.content[0]!.text, '帖子摘要')

  service.reset()
  await assert.rejects(run('xai_x_search', { query: 'q', from_date: '9/1' }, ctx), /from_date 须为 YYYY-MM-DD/)
  assert.equal(service.requests.length, 0)
})

test('xai_image 生成与改图的请求形状', async () => {
  const cwd = tmpCwd()
  writeFileSync(join(cwd, 'a.png'), PNG)
  writeFileSync(join(cwd, 'b.jpg'), JPEG)
  writeFileSync(join(cwd, 'c.gif'), Buffer.from('GIF89a'))
  const ctx = ctxFor('xai', staticRegistry({ xai: 'xai-token-1' }), cwd)
  const reply = () => ({ json: { data: [{ b64_json: PNG.toString('base64') }] } })
  service.on('POST /v1/images/generations', reply)
  service.on('POST /v1/images/edits', reply)

  const generated = await run('xai_image', { prompt: '山', aspect_ratio: '16:9' }, ctx)
  assert.deepEqual(service.requests[0]!.body, {
    model: 'grok-imagine-image-2.0',
    prompt: '山',
    n: 1,
    response_format: 'b64_json',
    aspect_ratio: '16:9'
  })
  assert.equal(dirname(generated.details.savedPath as string), join(cwd, IMAGE_OUTPUT_DIR))

  await run('xai_image', { prompt: '改色', images: ['a.png'] }, ctx)
  const single = service.requests[1]!.body
  assert.deepEqual(single.image, { url: `data:image/png;base64,${PNG.toString('base64')}` })
  assert.equal(single.images, undefined)
  assert.equal(single.resolution, '1k')

  await run('xai_image', { prompt: '合成', images: ['a.png', 'b.jpg'] }, ctx)
  const multiple = service.requests[2]!.body
  assert.equal(multiple.images.length, 2)
  assert.match(multiple.images[1].url, /^data:image\/jpeg;base64,/)
  assert.equal(multiple.aspect_ratio, 'auto')

  await assert.rejects(run('xai_image', { prompt: 'x', images: ['c.gif'] }, ctx), /只接受 png\/jpg/)
  await assert.rejects(run('xai_image', { prompt: 'x', aspect_ratio: '5:4' }, ctx), /aspect_ratio 只能是/)
  assert.equal(service.requests.length, 3)
})

test('401 后向 Pi 重取令牌，换到新令牌就重试一次', async () => {
  service.on(
    'POST /v1/responses',
    request =>
      request.headers.authorization === 'Bearer fresh' ? { json: { output_text: 'ok' } } : { status: 401, json: {} },
    request =>
      request.headers.authorization === 'Bearer fresh' ? { json: { output_text: 'ok' } } : { status: 401, json: {} }
  )
  const registry = staticRegistry({ xai: ['stale', 'fresh'] })
  const result = await run('xai_web_search', { query: 'q' }, ctxFor('xai', registry))
  assert.equal(result.content[0]!.text, 'ok')
  assert.deepEqual(
    service.requests.map(request => request.headers.authorization),
    ['Bearer stale', 'Bearer fresh']
  )
})

test('失败给出可读原因且不带令牌', async () => {
  const token = codexJwt('acct', 'secret-nonce')
  const codex = ctxFor('openai-codex', staticRegistry({ 'openai-codex': token }))

  service.on('POST /backend-api/codex/alpha/search', () => ({
    status: 401,
    json: { error: { message: `invalid token Bearer ${token}` } }
  }))
  const unauthorized = await run('codex_search', { query: 'q' }, codex).catch((error: Error) => error)
  assert.ok(unauthorized instanceof Error)
  assert.match(unauthorized.message, /Codex 搜索鉴权失败（HTTP 401）.*登录可能已失效/)
  assert.doesNotMatch(unauthorized.message, /secret-nonce|eyJ/)
  // 同一令牌不重试。
  assert.equal(service.requests.length, 1)

  service.on('POST /backend-api/codex/alpha/search', () => ({
    status: 429,
    json: { error: { message: 'usage limit' } }
  }))
  await assert.rejects(run('codex_search', { query: 'q' }, codex), /被限流或额度用尽（HTTP 429）：usage limit/)

  service.on('POST /backend-api/codex/alpha/search', () => ({ status: 502, text: '<html>bad gateway</html>' }))
  await assert.rejects(run('codex_search', { query: 'q' }, codex), /服务端出错（HTTP 502）/)

  service.on('POST /backend-api/codex/alpha/search', () => ({ text: 'not json' }))
  await assert.rejects(run('codex_search', { query: 'q' }, codex), /返回的不是 JSON/)

  await assert.rejects(
    run('xai_web_search', { query: 'q' }, ctxFor('xai', staticRegistry({}))),
    /没有 xai 的登录凭据.*\/login/
  )
  await assert.rejects(
    run('codex_search', { query: 'q' }, ctxFor('openai-codex', staticRegistry({ 'openai-codex': 'plain-token' }))),
    /令牌里没有 ChatGPT 账号信息/
  )
})

/** 用真实 Pi ModelRuntime 走令牌刷新；只把 OAuth 刷新端点拦到本地，其余请求照常发往假服务。 */
async function withPiRegistry(
  provider: 'openai-codex' | 'xai',
  tokenUrl: string,
  refreshed: Reply,
  body: (registry: ModelRegistry, store: InMemoryCredentialStore, refreshCalls: URLSearchParams[]) => Promise<void>
) {
  const store = new InMemoryCredentialStore()
  await store.modify(provider, async () => ({
    type: 'oauth',
    access: 'expired-access',
    refresh: 'refresh-1',
    expires: 0
  }))
  const refreshCalls: URLSearchParams[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.startsWith(tokenUrl)) {
      refreshCalls.push(new URLSearchParams(String(init?.body ?? '')))
      return new Response(refreshed.text ?? JSON.stringify(refreshed.json), {
        status: refreshed.status ?? 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    if (!url.startsWith(service.base)) throw new Error(`unexpected network request: ${url}`)
    return realFetch(input, init)
  }) as typeof fetch
  try {
    const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null, refreshOnCreate: false })
    await body(new ModelRegistry(runtime), store, refreshCalls)
  } finally {
    globalThis.fetch = realFetch
  }
}

test('令牌过期时经 Pi 刷新后再发请求，新令牌写回 Pi 的凭据库', async () => {
  const fresh = codexJwt('acct-9', 'fresh')
  service.on('POST /backend-api/codex/alpha/search', () => ({ json: { output: 'ok', results: [] } }))
  await withPiRegistry(
    'openai-codex',
    'https://auth.openai.com/oauth/token',
    { json: { access_token: fresh, refresh_token: 'refresh-2', expires_in: 3600 } },
    async (registry, store, refreshCalls) => {
      await run('codex_search', { query: 'q' }, ctxFor('openai-codex', registry))
      assert.equal(refreshCalls.length, 1)
      assert.equal(refreshCalls[0]!.get('refresh_token'), 'refresh-1')
      assert.equal(service.requests[0]!.headers.authorization, `Bearer ${fresh}`)
      assert.equal(service.requests[0]!.headers['chatgpt-account-id'], 'acct-9')
      const stored = (await store.read('openai-codex')) as { access: string; refresh: string }
      assert.equal(stored.access, fresh)
      assert.equal(stored.refresh, 'refresh-2')
    }
  )

  service.reset()
  service.on('POST /v1/images/generations', () => ({ json: { data: [{ b64_json: PNG.toString('base64') }] } }))
  await withPiRegistry(
    'xai',
    'https://auth.x.ai/oauth2/token',
    { json: { access_token: 'xai-fresh', refresh_token: 'refresh-2', expires_in: 3600, token_type: 'Bearer' } },
    async (registry, _store, refreshCalls) => {
      await run('xai_image', { prompt: '山' }, ctxFor('xai', registry))
      assert.equal(refreshCalls.length, 1)
      assert.equal(service.requests[0]!.headers.authorization, 'Bearer xai-fresh')
    }
  )
})

test('Pi 刷新失败时说明原因并提示重新登录，不发业务请求', async () => {
  await withPiRegistry(
    'xai',
    'https://auth.x.ai/oauth2/token',
    { status: 400, json: { error: 'invalid_grant' } },
    async registry => {
      const error = await run('xai_web_search', { query: 'q' }, ctxFor('xai', registry)).catch((e: Error) => e)
      assert.ok(error instanceof Error)
      assert.match(error.message, /xai 令牌刷新失败.*\/login/)
      assert.doesNotMatch(error.message, /refresh-1|expired-access/)
    }
  )
  assert.equal(service.requests.length, 0)
})

test('真实 Pi 会话：加载扩展后切换模型，活动工具跟着 provider 走', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-tools-pi-'))
  const agentDir = join(root, 'agent')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    const store = new InMemoryCredentialStore()
    const future = Date.now() + 3_600_000
    await store.modify('openai-codex', async () => ({
      type: 'oauth',
      access: codexJwt('acct', 'pi'),
      refresh: 'r',
      expires: future
    }))
    await store.modify('xai', async () => ({ type: 'oauth', access: 'xai', refresh: 'r', expires: future }))
    await store.modify('kimi-coding', async () => ({ type: 'api_key', key: 'kimi' }))
    const modelRuntime = await ModelRuntime.create({ credentials: store, modelsPath: null, refreshOnCreate: false })
    const settingsManager = SettingsManager.inMemory()
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: [fileURLToPath(new URL('../../src/hosted-tools/extension.ts', import.meta.url))]
    })
    await loader.reload()
    const model = (provider: string) => {
      const found = modelRuntime.getModels(provider)[0]
      assert.ok(found, provider)
      return found
    }
    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      modelRuntime,
      model: model('openai-codex'),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
      settingsManager
    })
    try {
      const errors: unknown[] = []
      await session.bindExtensions({ onError: error => errors.push(error) })
      const hosted = () => session.getActiveToolNames().filter(name => HOSTED.includes(name))
      assert.deepEqual(hosted(), ['codex_search', 'codex_image'])
      assert.ok(session.getActiveToolNames().includes('read'))

      await session.setModel(model('xai'))
      assert.deepEqual(hosted(), ['xai_web_search', 'xai_x_search', 'xai_image'])
      await session.setModel(model('kimi-coding'))
      assert.deepEqual(hosted(), [])
      await session.setModel(model('openai-codex'))
      assert.deepEqual(hosted(), ['codex_search', 'codex_image'])
      assert.ok(session.getActiveToolNames().includes('read'))
      // 参数是普通 JSON Schema，Pi 能原样列出。
      const info = session.getAllTools().find(tool => tool.name === 'xai_image')
      assert.deepEqual(Object.keys((info?.parameters as { properties: object }).properties), [
        'prompt',
        'images',
        'aspect_ratio'
      ])
      assert.deepEqual(errors, [])
    } finally {
      session.dispose()
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  }
})
