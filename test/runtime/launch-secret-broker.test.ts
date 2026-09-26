import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createLaunchSecretBroker, LAUNCH_SECRET_GREETING } from '../../src/runtime/launch-secret-broker.js'
import { LAUNCH_SECRET_ROOT_ENV } from '../../src/runtime/launch-secret.js'

const root = mkdtempSync(join(tmpdir(), 'launch-broker-test-'))
const previousRoot = process.env[LAUNCH_SECRET_ROOT_ENV]
process.env[LAUNCH_SECRET_ROOT_ENV] = root
const account = join(root, 'k1')
mkdirSync(account, { mode: 0o700 })
chmodSync(account, 0o700)
writeFileSync(join(account, 'claude-setup-token'), 'fake-setup-token', { mode: 0o600 })
process.once('exit', () => {
  if (previousRoot === undefined) delete process.env[LAUNCH_SECRET_ROOT_ENV]
  else process.env[LAUNCH_SECRET_ROOT_ENV] = previousRoot
  rmSync(root, { recursive: true, force: true })
})

function take(path: string, greeting: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let result = ''
    socket.on('connect', () => socket.end(`${greeting}\n`))
    socket.on('data', chunk => {
      result += chunk.toString('utf8')
    })
    socket.on('end', () => resolve(result))
    socket.on('error', reject)
  })
}

test('broker serves one capability-declared requester and closes before the next turn', async () => {
  const broker = await createLaunchSecretBroker('k1')
  try {
    assert.equal(statSync(dirname(broker.path)).mode & 0o777, 0o700)
    assert.equal(statSync(broker.path).mode & 0o777, 0o600)
    assert.equal(readFileSync(join(account, 'claude-setup-token'), 'utf8'), 'fake-setup-token')
    assert.equal(broker.taken, false)
    assert.equal(await take(broker.path, `${LAUNCH_SECRET_GREETING} ${broker.challenge}`), 'fake-setup-token\n')
    assert.equal(broker.taken, true)
    assert.equal(existsSync(dirname(broker.path)), false)
    await assert.rejects(take(broker.path, `${LAUNCH_SECRET_GREETING} ${broker.challenge}`), /ENOENT|ECONNREFUSED/)
  } finally {
    broker.close()
  }
})

test('no bridge claim expires, and a crashed Pi closes its outstanding broker', async () => {
  const missingBridge = await createLaunchSecretBroker('k1', 25)
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(missingBridge.taken, false)
  assert.equal(existsSync(dirname(missingBridge.path)), false)
  await assert.rejects(take(missingBridge.path, `${LAUNCH_SECRET_GREETING} ${missingBridge.challenge}`), /ENOENT/)

  const crashedPi = await createLaunchSecretBroker('k1')
  crashedPi.close()
  assert.equal(existsSync(dirname(crashedPi.path)), false)
})

test('unknown capability never receives a token or consumes the one-shot channel', async () => {
  const broker = await createLaunchSecretBroker('k1')
  try {
    // An invalid claim closes the connection, but a later valid bridge may
    // still declare support during extension loading.
    assert.equal(await take(broker.path, `READY unknown-extension ${broker.challenge}`), '')
    assert.equal(await take(broker.path, `${LAUNCH_SECRET_GREETING} ${'0'.repeat(64)}`), '')
    assert.equal(broker.taken, false)
    broker.close()
    await assert.rejects(take(broker.path, `${LAUNCH_SECRET_GREETING} ${broker.challenge}`), /ENOENT|ECONNREFUSED/)
  } finally {
    broker.close()
  }
})
