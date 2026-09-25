import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const IDENTITY_LAUNCH_SECRET_CAPABILITY = 'pi-acp/identity/launch-secret-file/v1'
export const LAUNCH_SECRET_ROOT_ENV = 'PI_ACP_LAUNCH_SECRET_ROOT'
export const LAUNCH_SECRET_NAME = 'claude-setup-token'

/** Only an account number crosses ACP. The value is read just before spawning its Pi. */
export function readLaunchSecret(
  account: string,
  root: string | undefined = process.env[LAUNCH_SECRET_ROOT_ENV]
): string {
  if (!root || !isAbsolute(root)) throw new Error('Identity launch secret root is missing')
  if (!/^k[0-9]+$/.test(account)) throw new Error('Invalid launch secret account number')
  const safeRoot = realpathSync(root)
  const accountPath = join(safeRoot, account)
  const path = join(accountPath, LAUNCH_SECRET_NAME)
  // Never follow an account-dir or file symlink, even to a target inside the root.
  if (realpathSync(accountPath) !== accountPath || realpathSync(path) !== path)
    throw new Error('Identity launch secret path leaves its account directory')
  const accountDir = lstatSync(accountPath)
  const file = lstatSync(path)
  if (!accountDir.isDirectory() || accountDir.isSymbolicLink() || !file.isFile() || file.isSymbolicLink())
    throw new Error('Identity launch secret must be an ordinary file in an account directory')
  if (accountDir.uid !== process.getuid?.() || (accountDir.mode & 0o777) !== 0o700)
    throw new Error('Identity launch secret account directory must be private')
  if (file.uid !== process.getuid?.() || (file.mode & 0o777) !== 0o600 || file.size > 4097)
    throw new Error('Identity launch secret owner, mode or size is invalid')
  const value = readFileSync(path, 'utf8').trim()
  if (!value || /\s/.test(value)) throw new Error('Identity launch secret is empty or malformed')
  return value
}

/** Token identities must not inherit local Claude login or alternate auth sources. */
export function applyLaunchSecret(env: NodeJS.ProcessEnv, account: string, agentDirectory: string): void {
  const token = readLaunchSecret(account)
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
    'CLAUDE_CODE_USE_VERTEX'
  ])
    delete env[key]
  env.CLAUDE_CONFIG_DIR = configDir
  env.CLAUDE_CODE_OAUTH_TOKEN = token
}
