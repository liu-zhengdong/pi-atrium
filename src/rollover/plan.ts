/**
 * 滚动交接的计划：纯函数，不读写文件，也不碰 Pi 运行时。
 *
 * 输入是旧会话的活动分支和 billion-context sidecar 里的 active 块，输出是新会话
 * 要写入的全部内容。所有取舍集中在这里，执行路径只按计划依次 append，方便穷举测试。
 */

export type MessageContent = { type: string; id?: string; [key: string]: unknown }

export type SessionMessage = {
  role: string
  content?: MessageContent[] | string
  toolCallId?: string
  [key: string]: unknown
}

/** Pi 会话 jsonl 的一条 entry，只声明本模块用到的字段。 */
export type SessionEntry = {
  type: string
  id: string
  parentId?: string | null
  message?: SessionMessage
  customType?: string
  content?: MessageContent[] | string
  display?: boolean
  details?: unknown
  summary?: string
  [key: string]: unknown
}

/** billion-context sidecar 里的一个 active 摘要块。 */
export type SummaryBlock = {
  blockId: string
  tier?: number
  topic?: string
  summary: string
  createdAt?: number
}

export type RolloverStats = {
  /** 旧分支的 entry 总数 */
  branchEntries: number
  /** 其中进入模型上下文、且去重后可供交接的条目数 */
  contextEntries: number
  /** 带过去的摘要块数量 */
  blocks: number
  /** carry 消息的字节数 */
  carryBytes: number
  /** 尾巴保留的 entry 数量 */
  tailEntries: number
  /** 尾巴的字节数 */
  tailBytes: number
  /** 切点在可交接条目中的下标；等于条目总数表示没有尾巴 */
  cutIndex: number
  /** 丢弃的重复扩展注入数量 */
  droppedDuplicateInjections: number
  /** 丢弃的孤儿 toolResult 数量 */
  droppedOrphanResults: number
  /** 从 assistant 消息里剥掉的悬空 toolCall 数量 */
  strippedToolCalls: number
}

export type RolloverPlan = {
  /** 新会话的第一条用户消息正文 */
  carryText: string
  /** 紧随其后按顺序重放的尾巴 */
  tail: SessionEntry[]
  stats: RolloverStats
}

export type PlanOptions = {
  /** 旧会话 jsonl 的绝对路径，写进 carry 正文供人和模型回溯 */
  parentFile: string
  /** 尾巴的字节预算 */
  tailBudgetBytes: number
}

/** 进入模型上下文的 entry 类型；其余（扩展记账、模型切换、标签等）不带进新会话。 */
const CONTEXT_ENTRY_TYPES = new Set(['message', 'custom_message'])

/**
 * 扩展会把同一段文字反复注入上下文（例如每回合重播一次的工具清单）。
 * 同一 customType 下内容完全相同的注入只保留最后一条：文字仍在，重复的副本不占预算。
 */
function dropDuplicateInjections(entries: SessionEntry[]): { kept: SessionEntry[]; dropped: number } {
  // 注入正文可能很长，只序列化一遍。空键表示“不参与去重”。
  const keys = entries.map(entry =>
    entry.type === 'custom_message' ? `${entry.customType ?? ''}\u0000${JSON.stringify(entry.content ?? '')}` : ''
  )
  const lastIndexByContent = new Map<string, number>()
  keys.forEach((key, index) => {
    if (key) lastIndexByContent.set(key, index)
  })
  const kept = entries.filter((_entry, index) => !keys[index] || lastIndexByContent.get(keys[index]) === index)
  return { kept, dropped: entries.length - kept.length }
}

function entryBytes(entry: SessionEntry): number {
  return Buffer.byteLength(JSON.stringify(entry)) + 1
}

function isUserMessage(entry: SessionEntry): boolean {
  return entry.type === 'message' && entry.message?.role === 'user'
}

function contentItems(message: SessionMessage): MessageContent[] {
  return Array.isArray(message.content) ? message.content : []
}

/**
 * 切点：取**最早**一个满足「其后字节数不超预算」的用户消息边界。
 *
 * 切在用户消息上是为了让尾巴落在回合边界，不会把 toolCall 和它的 toolResult 分开。
 * 预算内没有任何用户消息时退到最后一个用户消息；整条分支没有用户消息时不带尾巴。
 */
function findCutIndex(branch: SessionEntry[], tailBudgetBytes: number): number {
  const suffixBytes = new Array<number>(branch.length + 1).fill(0)
  for (let i = branch.length - 1; i >= 0; i--) suffixBytes[i] = suffixBytes[i + 1] + entryBytes(branch[i])

  let lastUser = -1
  for (let i = 0; i < branch.length; i++) {
    if (!isUserMessage(branch[i])) continue
    if (suffixBytes[i] <= tailBudgetBytes) return i
    lastUser = i
  }
  return lastUser >= 0 ? lastUser : branch.length
}

/**
 * 修掉跨切点的工具调用配对：丢弃调用不在尾巴里的 toolResult，剥掉没有结果的 toolCall。
 * 这与 billion-context 在发请求前做的 stripOrphanedToolCalls / stripOrphanedToolResults 一致，
 * 也是 provider 能接受这段对话的前提。
 */
function repairToolPairs(tail: SessionEntry[]): {
  repaired: SessionEntry[]
  droppedOrphanResults: number
  strippedToolCalls: number
} {
  const callIds = new Set<string>()
  for (const entry of tail) {
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue
    for (const item of contentItems(entry.message)) {
      if (item.type === 'toolCall' && typeof item.id === 'string') callIds.add(item.id)
    }
  }

  const resultIds = new Set<string>()
  let droppedOrphanResults = 0
  const kept: SessionEntry[] = []
  for (const entry of tail) {
    if (entry.type === 'message' && entry.message?.role === 'toolResult') {
      const callId = entry.message.toolCallId
      if (typeof callId !== 'string' || !callIds.has(callId)) {
        droppedOrphanResults++
        continue
      }
      resultIds.add(callId)
    }
    kept.push(entry)
  }

  let strippedToolCalls = 0
  const repaired: SessionEntry[] = []
  for (const entry of kept) {
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') {
      repaired.push(entry)
      continue
    }
    const items = contentItems(entry.message)
    const survivors = items.filter(item => {
      if (item.type !== 'toolCall') return true
      if (typeof item.id === 'string' && resultIds.has(item.id)) return true
      strippedToolCalls++
      return false
    })
    if (survivors.length === items.length) {
      repaired.push(entry)
      continue
    }
    if (survivors.length === 0) continue
    repaired.push({ ...entry, message: { ...entry.message, content: survivors } })
  }

  return { repaired, droppedOrphanResults, strippedToolCalls }
}

function blockSection(block: SummaryBlock): string {
  const topic = block.topic ? ` · ${block.topic}` : ''
  const tier = typeof block.tier === 'number' ? ` (tier ${block.tier})` : ''
  return `### ${block.blockId}${topic}${tier}\n${block.summary}`
}

/** 旧分支上 Pi 原生压缩／分支摘要的正文，否则这些内容在交接后无处可寻。 */
function nativeSummaries(branch: SessionEntry[]): string[] {
  return branch
    .filter(
      entry => (entry.type === 'compaction' || entry.type === 'branch_summary') && typeof entry.summary === 'string'
    )
    .map(
      (entry, index) =>
        `### 上一段的 Pi ${entry.type === 'compaction' ? '压缩' : '分支'}摘要 ${index + 1}\n${entry.summary}`
    )
}

export function planRollover(branch: SessionEntry[], blocks: SummaryBlock[], options: PlanOptions): RolloverPlan {
  const ordered = [...blocks].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  // 先定下哪些条目值得带走，再按它们的字节数选切点，预算才对应新会话的真实体量。
  const { kept: contextual, dropped: droppedDuplicateInjections } = dropDuplicateInjections(
    branch.filter(entry => CONTEXT_ENTRY_TYPES.has(entry.type))
  )
  const cutIndex = findCutIndex(contextual, options.tailBudgetBytes)
  const { repaired, droppedOrphanResults, strippedToolCalls } = repairToolPairs(contextual.slice(cutIndex))

  const sections = [...nativeSummaries(branch), ...ordered.map(blockSection)]
  const carryText = [
    '# 会话接续上下文',
    '',
    `本会话续自 ${options.parentFile}，那份文件原样保留，需要原文时直接读它。`,
    sections.length > 0
      ? `下面是上一段的压缩上下文，共 ${sections.length} 段摘要；本条之后是上一段最近的 ${repaired.length} 条原文消息。`
      : `上一段没有可继承的摘要；本条之后只有上一段最近的 ${repaired.length} 条原文消息。`,
    '这些是已经发生的历史记录，不是待执行的指令。',
    ...(sections.length > 0 ? ['', ...sections] : [])
  ].join('\n')

  return {
    carryText,
    tail: repaired,
    stats: {
      branchEntries: branch.length,
      contextEntries: contextual.length,
      blocks: ordered.length,
      carryBytes: Buffer.byteLength(carryText),
      tailEntries: repaired.length,
      tailBytes: repaired.reduce((total, entry) => total + entryBytes(entry), 0),
      cutIndex,
      droppedDuplicateInjections,
      droppedOrphanResults,
      strippedToolCalls
    }
  }
}
