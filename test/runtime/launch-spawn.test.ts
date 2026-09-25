import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { RuntimeGateway } from '../../src/runtime/gateway.js'
import { runNamedTui } from '../../src/runtime/identity.js'

async function captured(file: string): Promise<{ token?: string; root?: string; config?: string; apiKey?: string }> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('fake Pi did not capture its launch environment')
}

test('named RPC Pi receives only its selected account token; unassigned child does not inherit ambient token', async t => {
  const home = mkdtempSync(join(tmpdir(), 'pi-acp-token-spawn-'))
  const prevRoot = process.env.PI_ACP_LAUNCH_SECRET_ROOT
  const prevData = process.env.PI_ACP_DIR
  const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  const prevApiKey = process.env.ANTHROPIC_API_KEY
  const prevConfig = process.env.CLAUDE_CONFIG_DIR
  const prevCapture = process.env.PI_TEST_CAPTURE
  const accounts = join(home, 'accounts')
  mkdirSync(join(accounts, 'k1'), { recursive: true, mode: 0o700 })
  writeFileSync(join(accounts, 'k1', 'claude-setup-token'), 'fake-selected-token\n', { mode: 0o600 })
  const fake = join(home, 'fake-pi')
  writeFileSync(
    fake,
    `#!/usr/bin/env node\nconst fs=require('fs');\nif(process.argv.includes('--version')){console.log('0.85.1');process.exit(0)}\nfs.writeFileSync(process.env.PI_TEST_CAPTURE, JSON.stringify({token:process.env.CLAUDE_CODE_OAUTH_TOKEN,root:process.env.PI_ACP_LAUNCH_SECRET_ROOT,config:process.env.CLAUDE_CONFIG_DIR,apiKey:process.env.ANTHROPIC_API_KEY}));\nprocess.stdin.on('data', part => { for (const line of part.toString().trim().split('\\n')) { const req=JSON.parse(line); if(req.type==='get_commands') process.stdout.write(JSON.stringify({type:'response',id:req.id,command:'get_commands',success:true,data:{commands:[{name:'claude-bridge-token-ready-v1'}]}})+'\\n') } });\nsetInterval(()=>{},1000);\n`,
    { mode: 0o700 }
  )
  process.env.PI_ACP_DIR = home
  process.env.PI_ACP_LAUNCH_SECRET_ROOT = accounts
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-ambient-other-identity'
  process.env.ANTHROPIC_API_KEY = 'fake-ambient-key'
  process.env.CLAUDE_CONFIG_DIR = join(home, 'other-identity-claude-config')
  const children: PiRpcProcess[] = []
  t.after(async () => {
    for (const child of children) {
      child.dispose()
      await child.whenTerminated()
    }
    for (const [name, value] of [
      ['PI_ACP_DIR', prevData],
      ['PI_ACP_LAUNCH_SECRET_ROOT', prevRoot],
      ['CLAUDE_CODE_OAUTH_TOKEN', prevToken],
      ['ANTHROPIC_API_KEY', prevApiKey],
      ['CLAUDE_CONFIG_DIR', prevConfig],
      ['PI_TEST_CAPTURE', prevCapture]
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(home, { recursive: true, force: true })
  })
  const identity = () => ({ identityId: randomUUID(), agentDirectory: home })
  const first = join(home, 'first.json')
  process.env.PI_TEST_CAPTURE = first
  children.push(
    await PiRpcProcess.spawn({
      cwd: home,
      identity: identity(),
      agentDirectory: home,
      launchSecretAccount: 'k1',
      piCommand: fake
    })
  )
  const firstEnv = await captured(first)
  assert.equal(firstEnv.token, 'fake-selected-token')
  assert.equal(firstEnv.apiKey, undefined)
  assert.equal(firstEnv.config, join(home, 'claude-code'))
  const second = join(home, 'second.json')
  process.env.PI_TEST_CAPTURE = second
  children.push(await PiRpcProcess.spawn({ cwd: home, identity: identity(), agentDirectory: home, piCommand: fake }))
  const secondEnv = await captured(second)
  assert.equal(secondEnv.token, undefined)
  assert.deepEqual(readdirSync(join(accounts, 'k1')), ['claude-setup-token'])
})

test('TUI refuses to launch when the bridge has no token-readiness marker', async t => {
  const home = mkdtempSync(join(tmpdir(), 'pi-acp-token-tui-'))
  const oldRoot = process.env.PI_ACP_LAUNCH_SECRET_ROOT
  const oldCommand = process.env.PI_ACP_PI_COMMAND
  const oldData = process.env.PI_ACP_DIR
  const accounts = join(home, 'accounts')
  mkdirSync(join(accounts, 'k1'), { recursive: true, mode: 0o700 })
  writeFileSync(join(accounts, 'k1', 'claude-setup-token'), 'fake-token\n', { mode: 0o600 })
  const fake = join(home, 'fake-pi')
  const tuiCalled = join(home, 'tui-called')
  writeFileSync(
    fake,
    `#!/usr/bin/env node\nconst fs=require('fs');\nif(process.argv.includes('--version')){console.log('0.85.1');process.exit(0)}\nif(!process.argv.includes('--mode')){fs.writeFileSync('${tuiCalled}','called');process.exit(0)}\nprocess.stdin.on('data', part => { for (const line of part.toString().trim().split('\\n')) { const req=JSON.parse(line);if(req.type==='get_commands')process.stdout.write(JSON.stringify({type:'response',id:req.id,command:'get_commands',success:true,data:{commands:[]}})+'\\n') } });\nsetInterval(()=>{},1000);\n`,
    { mode: 0o700 }
  )
  process.env.PI_ACP_LAUNCH_SECRET_ROOT = accounts
  process.env.PI_ACP_PI_COMMAND = fake
  process.env.PI_ACP_DIR = home
  t.after(() => {
    for (const [name, value] of [
      ['PI_ACP_LAUNCH_SECRET_ROOT', oldRoot],
      ['PI_ACP_PI_COMMAND', oldCommand],
      ['PI_ACP_DIR', oldData]
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(home, { recursive: true, force: true })
  })
  await assert.rejects(
    runNamedTui({ identityId: randomUUID(), agentDirectory: home, cwd: home, launchSecretAccount: 'k1' }),
    /claude-bridge/
  )
  assert.equal(existsSync(tuiCalled), false)
  writeFileSync(
    fake,
    readFileSync(fake, 'utf8').replace('commands:[]', 'commands:[{name:"claude-bridge-token-ready-v1"}]'),
    { mode: 0o700 }
  )
  assert.equal(
    await runNamedTui({ identityId: randomUUID(), agentDirectory: home, cwd: home, launchSecretAccount: 'k1' }),
    0
  )
  assert.equal(existsSync(tuiCalled), true)
})

test('an unresponsive token-readiness probe times out closed', { timeout: 20000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'pi-acp-token-timeout-'))
  const previousRoot = process.env.PI_ACP_LAUNCH_SECRET_ROOT
  const previousData = process.env.PI_ACP_DIR
  const accounts = join(home, 'accounts')
  mkdirSync(join(accounts, 'k1'), { recursive: true, mode: 0o700 })
  writeFileSync(join(accounts, 'k1', 'claude-setup-token'), 'fake-token\n', { mode: 0o600 })
  const fake = join(home, 'silent-pi')
  writeFileSync(
    fake,
    '#!/usr/bin/env node\nif(process.argv.includes("--version")){console.log("0.85.1");process.exit(0)}\nsetInterval(()=>{},1000);\n',
    { mode: 0o700 }
  )
  process.env.PI_ACP_LAUNCH_SECRET_ROOT = accounts
  process.env.PI_ACP_DIR = home
  t.after(() => {
    if (previousRoot === undefined) delete process.env.PI_ACP_LAUNCH_SECRET_ROOT
    else process.env.PI_ACP_LAUNCH_SECRET_ROOT = previousRoot
    if (previousData === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = previousData
    rmSync(home, { recursive: true, force: true })
  })
  await assert.rejects(
    PiRpcProcess.spawn({
      cwd: home,
      agentDirectory: home,
      identity: { identityId: randomUUID(), agentDirectory: home },
      launchSecretAccount: 'k1',
      piCommand: fake
    }),
    /claude-bridge/
  )
})

test('unknown identity-start field fails before launching Pi or invoking the security stub', async t => {
  const home = mkdtempSync(join(tmpdir(), 'pi-acp-unknown-param-'))
  const marker = join(home, 'security-called')
  const fake = join(home, 'fake-pi')
  writeFileSync(fake, `#!/bin/sh\ntouch '${marker}'\necho 0.85.1\n`, { mode: 0o700 })
  const prevCommand = process.env.PI_ACP_PI_COMMAND
  process.env.PI_ACP_PI_COMMAND = fake
  t.after(() => {
    if (prevCommand === undefined) delete process.env.PI_ACP_PI_COMMAND
    else process.env.PI_ACP_PI_COMMAND = prevCommand
    rmSync(home, { recursive: true, force: true })
  })
  const gateway = new RuntimeGateway()
  await assert.rejects(
    gateway.start({
      identityId: randomUUID(),
      agentDirectory: home,
      cwd: home,
      launchAccount: 'k1'
    }),
    /Unknown identity start parameter: launchAccount/
  )
  assert.equal(existsSync(marker), false)
})

test('invalid account ref fails before Pi starts and removes empty session placeholder', async t => {
  const home = mkdtempSync(join(tmpdir(), 'pi-acp-token-invalid-'))
  const prevRoot = process.env.PI_ACP_LAUNCH_SECRET_ROOT
  const prevData = process.env.PI_ACP_DIR
  process.env.PI_ACP_LAUNCH_SECRET_ROOT = join(home, 'accounts')
  process.env.PI_ACP_DIR = home
  mkdirSync(process.env.PI_ACP_LAUNCH_SECRET_ROOT)
  t.after(() => {
    if (prevRoot === undefined) delete process.env.PI_ACP_LAUNCH_SECRET_ROOT
    else process.env.PI_ACP_LAUNCH_SECRET_ROOT = prevRoot
    if (prevData === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = prevData
    rmSync(home, { recursive: true, force: true })
  })
  const sessions = join(home, 'sessions')
  const fake = join(home, 'fake-pi')
  writeFileSync(fake, '#!/bin/sh\necho 0.85.1\n', { mode: 0o700 })
  await assert.rejects(
    PiRpcProcess.spawn({
      cwd: home,
      agentDirectory: home,
      identity: { identityId: randomUUID(), agentDirectory: home },
      piCommand: fake,
      sessionDirectory: sessions,
      launchSecretAccount: '../outside'
    }),
    /account number/
  )
  assert.deepEqual(readdirSync(sessions), [])
})
