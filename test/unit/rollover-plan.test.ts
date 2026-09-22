import test from 'node:test'
import assert from 'node:assert/strict'
import { planRollover, type SessionEntry, type SummaryBlock } from '../../src/rollover/plan.js'

let seq = 0
function user(text: string): SessionEntry {
  return {
    type: 'message',
    id: `u${++seq}`,
    parentId: null,
    message: { role: 'user', content: [{ type: 'text', text }] }
  }
}
function assistant(callIds: string[] = [], text = 'ok'): SessionEntry {
  return {
    type: 'message',
    id: `a${++seq}`,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }, ...callIds.map(id => ({ type: 'toolCall', id }))]
    }
  }
}
function toolResult(toolCallId: string): SessionEntry {
  return {
    type: 'message',
    id: `r${++seq}`,
    message: { role: 'toolResult', toolCallId, content: [{ type: 'text', text: 'done' }] }
  }
}
function firstText(entry: SessionEntry | undefined): unknown {
  const content = entry?.message?.content
  return Array.isArray(content) ? content[0]?.text : content
}
function block(blockId: string, createdAt: number, summary = `${blockId} 的摘要`): SummaryBlock {
  return { blockId, tier: 1, topic: `话题 ${blockId}`, summary, createdAt }
}

const options = { parentFile: '/tmp/parent.jsonl', tailBudgetBytes: 1024 * 1024 }

test('切点取预算内最早的用户消息边界', () => {
  const branch = [user('第一轮'), assistant(), user('第二轮'), assistant(), user('第三轮'), assistant()]
  const budget = branch.slice(2).reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry)) + 1, 0)
  const plan = planRollover(branch, [], { ...options, tailBudgetBytes: budget })
  assert.equal(plan.stats.cutIndex, 2)
  assert.equal(plan.stats.tailEntries, 4)
  assert.equal(firstText(plan.tail[0]), '第二轮')
})

test('预算装不下任何回合时退到最后一个用户消息', () => {
  const branch = [user('第一轮'), assistant(), user('第二轮'), assistant()]
  const plan = planRollover(branch, [], { ...options, tailBudgetBytes: 1 })
  assert.equal(plan.stats.cutIndex, 2)
  assert.equal(plan.stats.tailEntries, 2)
})

test('分支里没有用户消息时不带尾巴', () => {
  const plan = planRollover([assistant(), assistant()], [block('b1', 1)], options)
  assert.equal(plan.stats.tailEntries, 0)
  assert.equal(plan.stats.cutIndex, 2)
  assert.match(plan.carryText, /b1/)
})

test('丢弃调用留在切点之前的孤儿 toolResult', () => {
  const branch = [user('第一轮'), assistant(['call-old']), user('第二轮'), toolResult('call-old'), assistant()]
  const budget = branch.slice(2).reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry)) + 1, 0)
  const plan = planRollover(branch, [], { ...options, tailBudgetBytes: budget })
  assert.equal(plan.stats.droppedOrphanResults, 1)
  assert.equal(
    plan.tail.some(entry => entry.message?.role === 'toolResult'),
    false
  )
})

test('剥掉没有结果的悬空 toolCall，剥光的 assistant 整条丢弃', () => {
  const branch = [
    user('一轮'),
    assistant(['kept', 'dangling']),
    toolResult('kept'),
    {
      type: 'message',
      id: 'a-empty',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'lonely' }] }
    } as SessionEntry
  ]
  const plan = planRollover(branch, [], options)
  assert.equal(plan.stats.strippedToolCalls, 2)
  const survivor = plan.tail.find(entry => entry.id.startsWith('a'))
  assert.deepEqual(survivor?.message?.content, [
    { type: 'text', text: 'ok' },
    { type: 'toolCall', id: 'kept' }
  ])
  assert.equal(
    plan.tail.some(entry => entry.id === 'a-empty'),
    false
  )
})

test('计划不改动传入的分支', () => {
  const dangling = assistant(['no-result'])
  const branch = [user('一轮'), dangling]
  const before = JSON.stringify(branch)
  planRollover(branch, [], options)
  assert.equal(JSON.stringify(branch), before)
})

test('摘要块按 createdAt 排序写进 carry 正文', () => {
  const plan = planRollover([user('一轮')], [block('b9', 20), block('b3', 10)], options)
  assert.ok(plan.carryText.indexOf('b3') < plan.carryText.indexOf('b9'))
  assert.equal(plan.stats.blocks, 2)
  assert.match(plan.carryText, /不是待执行的指令/)
  assert.match(plan.carryText, /\/tmp\/parent\.jsonl/)
})

test('没有摘要块时 carry 正文说明只剩原文', () => {
  const plan = planRollover([user('一轮')], [], options)
  assert.match(plan.carryText, /没有可继承的摘要/)
  assert.equal(plan.stats.blocks, 0)
})

test('只带上下文可见的条目，扩展记账条目不进新会话', () => {
  const branch: SessionEntry[] = [
    user('一轮'),
    { type: 'custom', id: 'c1', customType: 'timing-line' },
    { type: 'model_change', id: 'm1' },
    { type: 'custom_message', id: 'cm1', customType: 'pi-acp-external', content: '外部消息', display: true },
    assistant()
  ]
  const plan = planRollover(branch, [], options)
  assert.deepEqual(
    plan.tail.map(entry => entry.type),
    ['message', 'custom_message', 'message']
  )
})

test('同一扩展重复注入的相同内容只留最后一条', () => {
  const inject = (id: string, text: string): SessionEntry => ({
    type: 'custom_message',
    id,
    customType: 'pi-acp-mcp-tools',
    content: text,
    display: false
  })
  const opening = user('一轮')
  const reply = assistant()
  const branch = [opening, inject('i1', '工具清单 A'), reply, inject('i2', '工具清单 A'), inject('i3', '工具清单 B')]
  const plan = planRollover(branch, [], options)
  assert.equal(plan.stats.droppedDuplicateInjections, 1)
  assert.deepEqual(
    plan.tail.map(entry => entry.id),
    [opening.id, reply.id, 'i2', 'i3']
  )
})

test('重复注入不占尾巴字节预算', () => {
  const noise = (id: string): SessionEntry => ({
    type: 'custom_message',
    id,
    customType: 'noisy',
    content: 'x'.repeat(400),
    display: false
  })
  const branch = [user('一轮'), assistant(), noise('n1'), noise('n2'), noise('n3'), noise('n4'), noise('n5')]
  const plan = planRollover(branch, [], { ...options, tailBudgetBytes: 900 })
  assert.equal(plan.stats.cutIndex, 0, '去重后整段应该能装进预算')
  assert.equal(plan.tail.filter(entry => entry.type === 'custom_message').length, 1)
})

test('Pi 原生压缩与分支摘要也带进 carry 正文', () => {
  const branch: SessionEntry[] = [
    { type: 'compaction', id: 'cp1', summary: '更早的压缩摘要' },
    { type: 'branch_summary', id: 'bs1', summary: '被放弃分支的摘要' },
    user('一轮')
  ]
  const plan = planRollover(branch, [block('b1', 1)], options)
  assert.match(plan.carryText, /更早的压缩摘要/)
  assert.match(plan.carryText, /被放弃分支的摘要/)
  assert.ok(plan.carryText.indexOf('更早的压缩摘要') < plan.carryText.indexOf('b1'))
})
