import { getMergedPiSettings } from '../acp/pi-settings.js'

export type RolloverConfig = {
  /** 超过阈值时是否提示交接 */
  enabled: boolean
  /** 会话文件多大之后提示交接 */
  thresholdBytes: number
  /** 交接时尾巴的字节预算 */
  tailBudgetBytes: number
}

/** 20MB 时 resume 约 11s，交接后约 4s；再往下压阈值只换来更频繁的交接。 */
const DEFAULT_THRESHOLD_MB = 20
/** 1MB 尾巴约等于一次交接保留最近一到两个回合的原文。 */
const DEFAULT_TAIL_BUDGET_KB = 1024

export const ROLLOVER_DEFAULTS: RolloverConfig = {
  enabled: true,
  thresholdBytes: DEFAULT_THRESHOLD_MB * 1024 * 1024,
  tailBudgetBytes: DEFAULT_TAIL_BUDGET_KB * 1024
}

function positiveNumber(value: unknown, fallback: number, unit: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value * unit) : fallback
}

function section(settings: Record<string, unknown>): Record<string, unknown> {
  const atrium = settings.atrium
  if (!atrium || typeof atrium !== 'object') return {}
  const rollover = (atrium as Record<string, unknown>).rollover
  return rollover && typeof rollover === 'object' ? (rollover as Record<string, unknown>) : {}
}

/**
 * 读 `atrium.rollover`，取值不合法就退回默认值。
 * 全部校验收在这一处，调用方拿到的一定是可直接使用的字节数。
 */
export function readRolloverConfig(cwd: string): RolloverConfig {
  const configured = section(getMergedPiSettings(cwd))
  return {
    enabled: configured.enabled === undefined ? ROLLOVER_DEFAULTS.enabled : configured.enabled !== false,
    thresholdBytes: positiveNumber(configured.thresholdMB, ROLLOVER_DEFAULTS.thresholdBytes, 1024 * 1024),
    tailBudgetBytes: positiveNumber(configured.tailBudgetKB, ROLLOVER_DEFAULTS.tailBudgetBytes, 1024)
  }
}
