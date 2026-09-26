import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isInheritedModelCredential } from '../../src/runtime/identity.js'

// pi-ai does not export its private provider→environment mapping. Compare our
// scrub predicate to the actual package used in tests and to the installed Pi
// CLI when available. A new literal provider variable must fail this test.
test('inherited credential scrub covers Pi provider environment keys', () => {
  const localPiAi = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'))), 'env-api-keys.js')
  const sources = [localPiAi]
  try {
    const piCli = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim())
    const installed = join(
      dirname(dirname(dirname(piCli))),
      'node_modules',
      '@earendil-works',
      'pi-ai',
      'dist',
      'env-api-keys.js'
    )
    if (existsSync(installed) && !sources.includes(installed)) sources.push(installed)
  } catch {
    // CI may only have the development dependency; it still checks its actual mapping.
  }
  for (const sourcePath of sources) {
    const source = readFileSync(sourcePath, 'utf8')
    assert.match(source, /function getApiKeyEnvVars\(/)
    assert.match(source, /function getEnvApiKey\(/)
    const keys = new Set([...source.matchAll(/["']([A-Z][A-Z0-9_]{3,})["']/g)].map(match => match[1]!))
    assert.ok(keys.size >= 40, `Pi provider mapping changed: ${sourcePath}`)
    for (const key of keys) assert.ok(isInheritedModelCredential(key), `Pi credential env not scrubbed: ${key}`)
  }
  for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    assert.ok(isInheritedModelCredential(key))
  }
  assert.equal(isInheritedModelCredential('PI_CODING_AGENT_DIR'), false)
  assert.equal(isInheritedModelCredential('PATH'), false)
})
