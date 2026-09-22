import { basename } from 'node:path'
import { Box, Markdown, Spacer, Text } from '@earendil-works/pi-tui'
import { getMarkdownTheme, keyText, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { CARRY_CUSTOM_TYPE, carriedParts, humanBytes, type CarryDetails } from './plan.js'

/** 注册渲染只用到这一项能力，接口保持与扩展其余部分一样窄。 */
export type CarryViewApi = Pick<ExtensionAPI, 'registerMessageRenderer'>

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
    .join('\n')
}

/** 折叠时那一句：说清带了什么、多重，尾巴留了几条。 */
function carriedLine(details: CarryDetails): string {
  const parts = carriedParts(details)
  const tail = `最近 ${details.tailEntries} 条原文（${humanBytes(details.tailBytes)}）`
  if (parts.length === 0) return `只有${tail}，更早的历史留在旧文件里`
  return `带上了${parts.join('、')}（${humanBytes(details.carryBytes)}）和${tail}`
}

/** 展开键的显示名。扩展从入口拿到的键位注册表与应用不共享，查不到时用默认键。 */
function expandKeyText(): string {
  return keyText('app.tools.expand') || 'ctrl+o'
}

/**
 * 接续条目在界面上的样子：折叠时只占四行，几十 KB 的摘要正文不铺满屏幕；
 * 展开键按下才渲染全文。模型看到的内容不受影响——display 只决定交互界面是否展示。
 */
export function registerCarryView(api: CarryViewApi): void {
  api.registerMessageRenderer<CarryDetails>(CARRY_CUSTOM_TYPE, (message, options, theme) => {
    const details = message.details
    const box = new Box(1, 1, t => theme.bg('customMessageBg', t))
    box.addChild(new Text(theme.fg('customMessageLabel', '\x1b[1m[接续上下文]\x1b[22m'), 0, 0))
    box.addChild(new Spacer(1))
    if (details) {
      box.addChild(new Text(theme.fg('customMessageText', `续自 ${basename(details.parentFile)}`), 0, 0))
      box.addChild(new Text(theme.fg('customMessageText', carriedLine(details)), 0, 0))
    } else {
      box.addChild(new Text(theme.fg('customMessageText', '更早的历史在本会话的旧文件里'), 0, 0))
    }
    if (options.expanded) {
      box.addChild(new Spacer(1))
      box.addChild(
        new Markdown(contentText(message.content), 0, 0, getMarkdownTheme(), {
          color: text => theme.fg('customMessageText', text)
        })
      )
    } else {
      box.addChild(new Text(`${theme.fg('dim', expandKeyText())} ${theme.fg('muted', '展开摘要正文')}`, 0, 0))
    }
    return box
  })
}
