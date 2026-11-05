import * as fs from 'fs'
import * as path from 'path'

// STELLA has no agent-specific code: behaviour that differs between agents is
// a manifest declaration, not `if (slug === …)`. This keeps it that way by
// failing the build when an agent's slug appears in platform code.
// See docs-site/docs/contributing/coding-standards/agent-platform.md.

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'src')

const ALLOWED = new Set([
  // The default agent type: the one place a slug is allowed.
  'src/agents/default-agent-type.ts',
  // Built-in image registry. Moves to the manifests in PR 3/5 ("images and scripts").
  'src/agent-image/agent-image.service.ts',
])

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sourceFiles(full)
    return /\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name) ? [full] : []
  })
}

describe('no agent slugs in platform code', () => {
  const slugs = fs
    .readdirSync(path.join(ROOT, 'agents'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ROOT, 'agents', entry.name, 'agent.yaml')))
    .map((entry) => entry.name)

  it('finds the built-in agents', () => {
    expect(slugs).toEqual(expect.arrayContaining(['stella-v2-agent', 'stella-light-agent']))
  })

  it('src/ names no agent outside the allowed files', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(ROOT, file)
      if (ALLOWED.has(rel)) continue
      const lines = fs.readFileSync(file, 'utf-8').split('\n')
      lines.forEach((line, i) => {
        // Code, not prose: a slug in quotes. Comments may name agents as examples.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
        if (slugs.some((slug) => new RegExp(`['"\`]${slug}['"\`]`).test(code))) offenders.push(`${rel}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
