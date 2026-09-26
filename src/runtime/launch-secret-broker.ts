import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLaunchSecret } from './launch-secret.js'

export const LAUNCH_SECRET_SOCKET_ENV = 'PI_ATRIUM_LAUNCH_SECRET_SOCKET'
export const LAUNCH_SECRET_CHALLENGE_ENV = 'PI_ATRIUM_LAUNCH_SECRET_CHALLENGE'
export const LAUNCH_SECRET_GREETING = 'READY claude-bridge-token-ready-v1'
const DEADLINE_MS = 30_000

export interface LaunchSecretBroker {
  readonly path: string
  /** Per-launch proof of possession, passed only to the Pi we spawned. */
  readonly challenge: string
  readonly taken: boolean
  close(): void
}

/** The Pi child receives only a socket name, never a token or a token file path.
 * The bridge announces its capability in-process before connecting. The first
 * valid connection gets the token; every later connection fails closed. The
 * socket is removed on success, Pi termination, or the bounded deadline. */
export async function createLaunchSecretBroker(account: string, deadlineMs = DEADLINE_MS): Promise<LaunchSecretBroker> {
  if (!/^k[0-9]+$/.test(account)) throw new Error('Invalid launch secret account number')
  // Validate path/ownership before spawning any Pi; the value stays in this
  // parent and is read again only if the new bridge declares support.
  void readLaunchSecret(account)
  const dir = mkdtempSync(join(tmpdir(), 'pi-atrium-secret-'))
  chmodSync(dir, 0o700)
  const path = join(dir, 's')
  const challenge = randomBytes(32).toString('hex')
  let taken = false
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const server: Server = createServer(socket => {
    socket.setTimeout(3000, () => socket.destroy())
    let request = ''
    socket.on('data', data => {
      request += data.toString('utf8')
      if (request.length > 256) {
        socket.destroy()
        return
      }
      const end = request.indexOf('\n')
      if (end < 0) return
      if (
        closed ||
        taken ||
        request.slice(0, end) !== `${LAUNCH_SECRET_GREETING} ${challenge}` ||
        request.length !== end + 1
      ) {
        socket.destroy()
        return
      }
      // Claim before reading so a second connection cannot also take it.
      taken = true
      try {
        socket.end(`${readLaunchSecret(account)}\n`)
      } catch {
        socket.destroy()
      }
      close()
    })
  })
  const close = () => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    chmodSync(path, 0o600)
    const stat = lstatSync(path)
    if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error('Launch secret broker is not a socket')
    timer = setTimeout(close, deadlineMs)
    timer.unref()
    return {
      path,
      challenge,
      get taken() {
        return taken
      },
      close
    }
  } catch (error) {
    close()
    throw error
  }
}

/** Set up only the identity's empty private config directory. Never put the
 * account root or token value into a Pi child's environment. */
export function prepareLaunchSecretEnvironment(
  env: NodeJS.ProcessEnv,
  agentDirectory: string,
  socket: LaunchSecretBroker
): void {
  const configDir = join(agentDirectory, 'claude-code')
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(configDir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error('Identity Claude config directory must be private')
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_OAUTH_TOKEN'
  ])
    delete env[key]
  env.CLAUDE_CONFIG_DIR = configDir
  env[LAUNCH_SECRET_SOCKET_ENV] = socket.path
  env[LAUNCH_SECRET_CHALLENGE_ENV] = socket.challenge
}
