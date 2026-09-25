import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { readLaunchSecret, LAUNCH_SECRET_NAME } from '../../src/runtime/launch-secret.js'

const home = mkdtempSync(join(tmpdir(), 'pi-acp-launch-secret-'))
const root = join(home, 'accounts')
mkdirSync(join(root, 'k1'), { recursive: true, mode: 0o700 })
const tokenFile = join(root, 'k1', LAUNCH_SECRET_NAME)
writeFileSync(tokenFile, 'fake-setup-token\n', { mode: 0o600 })
after(() => rmSync(home, { recursive: true, force: true }))

test('reads only the assigned account file with strict permissions', () => {
  assert.equal(readLaunchSecret('k1', root), 'fake-setup-token')
  assert.throws(() => readLaunchSecret('../k1', root), /account number/)
  assert.throws(() => readLaunchSecret('k1/../../outside', root), /account number/)
  assert.throws(() => readLaunchSecret('k9', root))
})

test('rejects an account directory symlink outside the trusted root', () => {
  const outside = join(home, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, LAUNCH_SECRET_NAME), 'fake-outside', { mode: 0o600 })
  symlinkSync(outside, join(root, 'k2'))
  assert.throws(() => readLaunchSecret('k2', root), /leaves its account directory/)
})

test('rejects a token file symlink, including one pointing inside the account root', () => {
  mkdirSync(join(root, 'k3'))
  symlinkSync(tokenFile, join(root, 'k3', LAUNCH_SECRET_NAME))
  assert.throws(() => readLaunchSecret('k3', root), /leaves its account directory/)
})

test('rejects a non-file, overly broad mode, or malformed token', () => {
  mkdirSync(join(root, 'k4', LAUNCH_SECRET_NAME), { recursive: true })
  assert.throws(() => readLaunchSecret('k4', root), /ordinary file/)
  chmodSync(join(root, 'k1'), 0o755)
  assert.throws(() => readLaunchSecret('k1', root), /account directory must be private/)
  chmodSync(join(root, 'k1'), 0o700)
  chmodSync(tokenFile, 0o644)
  assert.throws(() => readLaunchSecret('k1', root), /owner, mode or size/)
  chmodSync(tokenFile, 0o600)
  writeFileSync(tokenFile, 'fake token with spaces', { mode: 0o600 })
  assert.throws(() => readLaunchSecret('k1', root), /malformed/)
})
