import { statSync } from 'node:fs'
import { readRolloverConfig } from './config.js'
import { planRollover, CARRY_CUSTOM_TYPE, type RolloverPlan, type SessionEntry, type SessionMessage } from './plan.js'
import { readActiveBlocks } from './sidecar.js'

/** 新会话的写入面，只用到追加上下文可见条目的两个方法。 */
type AppendTarget = {
  appendMessage(message: SessionMessage): string
  appendCustomMessageEntry(customType: string, content: unknown, display: boolean, details?: unknown): string
}

type RolloverContext = {
  cwd: string
  hasUI: boolean
  ui: {
    notify(message: string, type?: 'info' | 'warning' | 'error'): void
    confirm(title: string, message: string): Promise<boolean>
  }
  sessionManager: {
    getSessionFile(): string | undefined
    getBranch(): SessionEntry[]
  }
}

/** 命令上下文额外带会话替换能力；Pi 只在用户主动执行的命令里提供这些方法。 */
type RolloverCommandContext = RolloverContext & {
  waitForIdle(): Promise<void>
  newSession(options?: {
    parentSession?: string
    setup?: (sessionManager: AppendTarget) => Promise<void>
  }): Promise<{ cancelled: boolean }>
}

export type RolloverExtensionApi = {
  on(name: string, handler: (event: unknown, ctx: RolloverContext) => unknown): void
  registerCommand(
    name: string,
    command: { description: string; handler(args: string, ctx: RolloverCommandContext): Promise<void> }
  ): void
}

function humanBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : `${(bytes / 1024).toFixed(1)}KB`
}

function sessionBytes(sessionFile: string): number {
  try {
    return statSync(sessionFile).size
  } catch {
    return 0
  }
}

function describe(plan: RolloverPlan, sessionFile: string): string {
  const { stats } = plan
  const notes = [
    stats.blocks === 0 && !stats.inheritedCarry
      ? '注意：没有可继承的摘要，切点之前的历史只会留在旧文件里，不进入新会话上下文。'
      : '旧会话文件原样保留，/resume 仍可回去。',
    stats.inheritedCarry ? '还没有新的压缩块，上一次交接的接续正文原样往下传。' : '',
    stats.droppedOrphanResults + stats.strippedToolCalls > 0
      ? `修掉跨切点的工具调用：丢弃 ${stats.droppedOrphanResults} 条孤儿结果，剥掉 ${stats.strippedToolCalls} 个悬空调用。`
      : '',
    stats.droppedDuplicateInjections > 0
      ? `合并 ${stats.droppedDuplicateInjections} 条重复的扩展注入，每种内容只留最后一条。`
      : ''
  ].filter(Boolean)
  return [
    `当前会话 ${humanBytes(sessionBytes(sessionFile))}，共 ${stats.branchEntries} 条。`,
    `新会话将带上 ${stats.blocks} 个摘要块（${humanBytes(stats.carryBytes)}）和最近 ${stats.tailEntries} 条原文（${humanBytes(stats.tailBytes)}）。`,
    ...notes
  ]
    .join('\n')
    .trim()
}

async function writePlan(sessionManager: AppendTarget, plan: RolloverPlan): Promise<void> {
  // 用 custom_message 而不是普通用户消息：模型照常看到，但下一代交接能认出这是接续上下文。
  sessionManager.appendCustomMessageEntry(CARRY_CUSTOM_TYPE, [{ type: 'text', text: plan.carryText }], true)
  for (const entry of plan.tail) {
    if (entry.type === 'message' && entry.message) sessionManager.appendMessage(entry.message)
    else if (entry.type === 'custom_message' && typeof entry.customType === 'string')
      sessionManager.appendCustomMessageEntry(
        entry.customType,
        entry.content ?? '',
        entry.display === true,
        entry.details
      )
  }
}

/**
 * 超长会话滚动交接。
 *
 * 会话文件越大，Pi 恢复时重排版整份 transcript 的代价越高；把旧会话压成「摘要 + 最近原文」
 * 放进新会话可以把这份代价降到固定开销。新会话头记录 parentSession，billion-context 据此
 * 继承已有压缩状态，旧文件与其旁挂状态原样留档。
 *
 * Pi 把 newSession 限定在用户主动执行的命令上下文里，所以这里只在超过阈值时提示一次，
 * 实际切换由用户执行 /rollover 触发。
 */
export default function rolloverExtension(pi: RolloverExtensionApi): void {
  let nudged = false

  pi.on('session_start', () => {
    nudged = false
  })

  pi.on('agent_settled', (_event, ctx) => {
    if (nudged || !ctx.hasUI) return
    const sessionFile = ctx.sessionManager.getSessionFile()
    if (!sessionFile) return
    const config = readRolloverConfig(ctx.cwd)
    if (!config.enabled) return
    const size = sessionBytes(sessionFile)
    if (size < config.thresholdBytes) return
    nudged = true
    ctx.ui.notify(
      `会话已 ${humanBytes(size)}，下次 resume 会明显变慢。执行 /rollover 交接到新会话，旧会话原样保留。`,
      'warning'
    )
  })

  pi.registerCommand('rollover', {
    description: '把当前长会话交接到新会话：带上摘要和最近原文，旧文件保留',
    handler: async (_args, ctx) => {
      await ctx.waitForIdle()
      const sessionFile = ctx.sessionManager.getSessionFile()
      if (!sessionFile) {
        ctx.ui.notify('当前会话没有落盘，无法交接。', 'error')
        return
      }
      const config = readRolloverConfig(ctx.cwd)
      const plan = planRollover(ctx.sessionManager.getBranch(), readActiveBlocks(sessionFile), {
        parentFile: sessionFile,
        tailBudgetBytes: config.tailBudgetBytes
      })
      if (plan.stats.tailEntries === 0 && plan.stats.blocks === 0) {
        ctx.ui.notify('这个会话没有可交接的内容。', 'warning')
        return
      }
      if (ctx.hasUI && !(await ctx.ui.confirm('交接到新会话？', describe(plan, sessionFile)))) return

      const result = await ctx.newSession({
        parentSession: sessionFile,
        setup: async sessionManager => writePlan(sessionManager, plan)
      })
      if (result.cancelled) ctx.ui.notify('交接被取消。', 'warning')
    }
  })
}
