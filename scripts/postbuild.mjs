// Post-build shim: make the vendored rc.2 dsh-llm-pi-ai run on a 0.1.2-alpha host.
//
// The vendored copy of @deepseek-ai/dsh-llm-pi-ai (0.1.1-rc.2) imports `CallId`
// from @deepseek-ai/dsh-llm. Every other symbol it needs still exists on the
// 0.1.2-alpha line, but `CallId` was removed there. It is a pure branding
// helper (`(id: string) => id`), so we strip it from the external import and
// inject a local implementation next to the bundled code.
import { readFileSync, writeFileSync } from 'node:fs'

const MODULE = '@deepseek-ai/dsh-llm'
const MISSING = ['CallId']
const STUB = 'function CallId(id) {\n\treturn id;\n}\n'

for (const file of process.argv.slice(2)) {
  let src = readFileSync(file, 'utf8')
  let changed = false
  for (const name of MISSING) {
    // Match `import { ... name ... } from "@deepseek-ai/dsh-llm"` (incl. multiline).
    const re = new RegExp(
      `(import\\s*\\{)([^}]*\\b${name}\\b[^}]*)(\\}\\s*from\\s*["']${MODULE.replaceAll('/', '\\/')}["'])`,
      'g',
    )
    if (!re.test(src)) continue
    src = src.replace(re, (_m, head, names, tail) => {
      const kept = names
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part && part.split(/\s+as\s+/)[0] !== name)
      return `${head}${kept.join(', ')}${tail}`
    })
    if (!src.includes(STUB)) src = `${STUB}\n${src}`
    changed = true
  }
  if (changed) {
    writeFileSync(file, src)
    console.log(`postbuild: patched ${file} (CallId stubbed for alpha hosts)`)
  }
}
