import { readFileSync } from 'node:fs'
import type { SummaryBlock } from './plan.js'

/**
 * 读取 billion-context 写在会话旁边的压缩状态。
 *
 * 该文件由别的扩展维护，格式可能随它升级；读不出来就当作没有摘要，交接仍可只带尾巴进行，
 * 不因为旁挂状态坏掉而让整个命令失败。
 */
export function sidecarPathFor(sessionFile: string): string {
  return `${sessionFile}.acp.json`
}

function isBlock(value: unknown): value is SummaryBlock & { active?: unknown } {
  if (!value || typeof value !== 'object') return false
  const block = value as Record<string, unknown>
  return typeof block.blockId === 'string' && typeof block.summary === 'string' && block.summary.length > 0
}

export function readActiveBlocks(sessionFile: string): SummaryBlock[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(sidecarPathFor(sessionFile), 'utf8'))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const blocks = (parsed as Record<string, unknown>).blocks
  if (!Array.isArray(blocks)) return []
  return blocks.filter(isBlock).filter(block => block.active === true)
}
