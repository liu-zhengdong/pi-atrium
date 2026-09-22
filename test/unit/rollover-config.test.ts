import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROLLOVER_DEFAULTS, readRolloverConfig } from '../../src/rollover/config.js'

/** 在临时工作目录写 .pi/settings.json，并把全局设置指向另一个空目录。 */
function withSettings(settings: unknown): string {
  const cwd = mkdtempSync(join(tmpdir(), 'rollover-config-'))
  mkdirSync(join(cwd, '.pi'))
  writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify(settings))
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'rollover-agent-'))
  return cwd
}

test('没有配置时用默认阈值和尾巴预算', () => {
  assert.deepEqual(readRolloverConfig(withSettings({})), ROLLOVER_DEFAULTS)
})

test('读取 atrium.rollover 的阈值与尾巴预算', () => {
  const config = readRolloverConfig(withSettings({ atrium: { rollover: { thresholdMB: 8, tailBudgetKB: 256 } } }))
  assert.equal(config.thresholdBytes, 8 * 1024 * 1024)
  assert.equal(config.tailBudgetBytes, 256 * 1024)
  assert.equal(config.enabled, true)
})

test('enabled 为 false 时不提示', () => {
  assert.equal(readRolloverConfig(withSettings({ atrium: { rollover: { enabled: false } } })).enabled, false)
})

test('非法取值一律退回默认值', () => {
  for (const bad of [0, -5, 'big', null, NaN, Infinity, {}]) {
    const config = readRolloverConfig(withSettings({ atrium: { rollover: { thresholdMB: bad, tailBudgetKB: bad } } }))
    assert.equal(config.thresholdBytes, ROLLOVER_DEFAULTS.thresholdBytes, `thresholdMB=${JSON.stringify(bad)}`)
    assert.equal(config.tailBudgetBytes, ROLLOVER_DEFAULTS.tailBudgetBytes, `tailBudgetKB=${JSON.stringify(bad)}`)
  }
})

test('atrium 或 rollover 不是对象时不抛错', () => {
  assert.deepEqual(readRolloverConfig(withSettings({ atrium: 'nope' })), ROLLOVER_DEFAULTS)
  assert.deepEqual(readRolloverConfig(withSettings({ atrium: { rollover: [1, 2] } })), ROLLOVER_DEFAULTS)
})
