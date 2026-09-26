import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('合集声明可安装的扩展入口', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string
    bin: Record<string, string>
    workspaces?: string[]
    pi: { extensions: string[] }
    dependencies: Record<string, string>
  }
  assert.equal(pkg.name, '@liuser/pi-atrium')
  for (const dep of ['@modelcontextprotocol/client', 'yaml', 'zod']) {
    assert.equal(typeof pkg.dependencies[dep], 'string', dep)
  }
  assert.equal(pkg.bin['pi-acp'], 'dist/index.js')
  assert.equal(pkg.workspaces, undefined)
  assert.deepEqual(pkg.pi.extensions, [
    './adapter/index.ts',
    './dist/pi-extension.js',
    './dist/rollover.js',
    './dist/hosted-tools.js',
    './notes/src/index.ts'
  ])
  for (const entry of pkg.pi.extensions) {
    assert.equal(existsSync(join(root, entry)), true, entry)
  }
})
