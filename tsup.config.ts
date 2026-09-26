import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'acp-extension': 'src/pi-rpc/acp-extension.ts',
    'pi-extension': 'src/runtime/extension.ts',
    rollover: 'src/rollover/extension.ts',
    'hosted-tools': 'src/hosted-tools/extension.ts',
    identity: 'src/runtime/identity.ts'
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  // Pi 与 Pi TUI 由宿主进程提供：扩展在 Pi 里运行，这两包必须外部化，
  // 否则 bundle 会带上一份自己的 Pi，与宿主实际版本脱节。
  external: ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'],
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  minify: false,
  banner: {
    js: '#!/usr/bin/env node'
  }
})
