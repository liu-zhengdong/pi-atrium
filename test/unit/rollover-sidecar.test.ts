import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readActiveBlocks, sidecarPathFor } from '../../src/rollover/sidecar.js'

function withSidecar(contents: string | undefined): string {
  const sessionFile = join(mkdtempSync(join(tmpdir(), 'rollover-sidecar-')), 'session.jsonl')
  writeFileSync(sessionFile, '')
  if (contents !== undefined) writeFileSync(sidecarPathFor(sessionFile), contents)
  return sessionFile
}

test('只取 active 且带正文的块', () => {
  const sessionFile = withSidecar(
    JSON.stringify({
      blocks: [
        { blockId: 'b1', summary: '保留', active: true },
        { blockId: 'b2', summary: '已被高层块吸收', active: false },
        { blockId: 'b3', summary: '', active: true },
        { blockId: 'b4', active: true },
        { summary: '没有 blockId', active: true },
        'not an object'
      ]
    })
  )
  assert.deepEqual(
    readActiveBlocks(sessionFile).map(block => block.blockId),
    ['b1']
  )
})

test('sidecar 缺失或坏掉时当作没有摘要，不抛错', () => {
  for (const contents of [undefined, '', '{', 'null', '[]', '{"blocks":"nope"}', '{"blocks":null}']) {
    assert.deepEqual(readActiveBlocks(withSidecar(contents)), [], JSON.stringify(contents))
  }
})
