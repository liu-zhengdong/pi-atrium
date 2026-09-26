import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RuntimeGateway } from '../../src/runtime/gateway.js'
import { recordPath, socketEndpoint } from '../../src/runtime/transport.js'

test('an identity in launch preflight is invisible and cannot be attached by runtime id', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-readiness-'))
  const prior = process.env.PI_ACP_DIR
  process.env.PI_ACP_DIR = root
  t.after(() => {
    if (prior === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = prior
    rmSync(root, { recursive: true, force: true })
  })
  const runtimeId = randomUUID(),
    identityId = randomUUID()
  writeFileSync(
    recordPath(runtimeId),
    JSON.stringify({
      runtimeId,
      generation: randomUUID(),
      sessionId: randomUUID(),
      pid: process.pid,
      ownerPid: process.pid,
      identityId,
      cwd: root,
      mode: 'rpc',
      endpoint: socketEndpoint(runtimeId),
      token: 'stub'
    }),
    { mode: 0o600 }
  )
  const gateway = new RuntimeGateway()
  t.after(() => gateway.close())
  const pending = (gateway as unknown as { pendingIdentities: Set<string> }).pendingIdentities
  pending.add(identityId)
  assert.deepEqual(gateway.list().runtimes, [])
  await assert.rejects(gateway.attach({ runtimeId }), /readiness is still being checked/)
  pending.delete(identityId)
  assert.equal(gateway.list().runtimes[0]?.runtimeId, runtimeId)
})
