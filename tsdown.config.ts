import type { UserConfig } from 'tsdown'

export default {
  entry: {
    index: 'src/index.ts',
    bin: 'src/bin.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      '@earendil-works/pi-ai',
      '@deepseek-ai/schemastery',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-atomic-write',
      '@deepseek-ai/dsh-attachment',
      '@deepseek-ai/dsh-home-paths',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-llm-pi-ai',
      '@deepseek-ai/dsh-settings',
    ],
  },
} satisfies UserConfig
