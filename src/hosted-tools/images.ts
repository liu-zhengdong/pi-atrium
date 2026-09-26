import { randomUUID } from 'node:crypto'
import { mkdir, open, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { HostedToolError } from './http.js'

/** 生成的图片统一存到工作目录下这里，与 pi-better-openai 的 project 模式同一位置。 */
export const IMAGE_OUTPUT_DIR = join('.pi', 'generated-images')

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export type ImageInput = { path: string; mimeType: ImageMime; dataUrl: string }

const EXTENSIONS: Record<ImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

/** 按文件头判断格式，不信扩展名。 */
export function sniffImage(bytes: Uint8Array): ImageMime | undefined {
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp'
  return undefined
}

export type ImageInputLimits = { maxCount: number; maxBytes: number; accept: readonly ImageMime[] }

/** 读本地图片作为改图输入：相对路径按 cwd 解析，逐张校验格式和大小，失败说清是哪张。 */
export async function readImageInputs(
  paths: readonly string[] | undefined,
  cwd: string,
  limits: ImageInputLimits
): Promise<ImageInput[]> {
  const list = (paths ?? []).map(path => path.trim()).filter(Boolean)
  if (list.length > limits.maxCount)
    throw new HostedToolError(`最多传 ${limits.maxCount} 张图片，收到 ${list.length} 张。`)
  const inputs: ImageInput[] = []
  for (const raw of list) {
    const path = isAbsolute(raw) ? raw : resolve(cwd, raw)
    const info = await stat(path).catch(() => undefined)
    if (!info?.isFile()) throw new HostedToolError(`图片不存在或不是文件：${raw}`)
    if (info.size > limits.maxBytes)
      throw new HostedToolError(`图片过大（${info.size} 字节，上限 ${limits.maxBytes}）：${raw}`)
    const bytes = await readFileBounded(path, limits.maxBytes)
    const mimeType = sniffImage(bytes)
    if (!mimeType || !limits.accept.includes(mimeType))
      throw new HostedToolError(
        `不支持的图片格式（只接受 ${limits.accept.map(type => EXTENSIONS[type]).join('/')}）：${raw}`
      )
    inputs.push({ path, mimeType, dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}` })
  }
  return inputs
}

async function readFileBounded(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
      if (length > maxBytes) throw new HostedToolError(`图片读取时超过 ${maxBytes} 字节上限：${path}`)
    }
    return buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
}

/** 把服务端返回的 base64 图片写到 `<cwd>/.pi/generated-images/`，返回绝对路径。 */
export async function saveGeneratedImage(cwd: string, prefix: string, base64: string): Promise<string> {
  const data = base64.replace(/^data:[^;,]+;base64,/, '').trim()
  const bytes = Buffer.from(data, 'base64')
  const mimeType = sniffImage(bytes)
  if (!mimeType) throw new HostedToolError('服务端返回的图片数据无法识别。')
  const dir = resolve(cwd, IMAGE_OUTPUT_DIR)
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(dir, `${prefix}-${stamp}-${randomUUID().slice(0, 8)}.${EXTENSIONS[mimeType]}`)
  await writeFile(path, bytes, { flag: 'wx' })
  return path
}
