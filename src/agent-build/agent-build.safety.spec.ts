import * as fs from 'fs'
import * as path from 'path'
import { buildImageName, resolveDockerfilePath } from './agent-build.service.js'

// The build runs `docker build` on the host with values from an uploaded package.
describe('agent build input checks', () => {
  it('builds <slug>:<version> from valid values', () => {
    expect(buildImageName('elias-interviewer', '0.1.0')).toBe('elias-interviewer:0.1.0')
  })

  it.each([
    ['x; touch /tmp/pwned', '1.0.0'],
    ['ok-slug', '1.0.0 && id'],
    ['$(id)', '1.0.0'],
    ['ok-slug', '1.0'],
  ])('refuses slug %j / version %j', (slug, version) => {
    expect(() => buildImageName(slug, version)).toThrow(/Invalid agent/)
  })

  it('resolves a plain relative Dockerfile inside the package', () => {
    expect(resolveDockerfilePath('/pkg', 'Dockerfile')).toBe(path.resolve('/pkg/Dockerfile'))
    expect(resolveDockerfilePath('/pkg', 'docker/Dockerfile.prod')).toBe(path.resolve('/pkg/docker/Dockerfile.prod'))
  })

  it.each(['../Dockerfile', 'a/../../etc/passwd', '/etc/passwd', 'Dockerfile; id', '$(id)', '-f', 'a b', ''])(
    'refuses Dockerfile path %j',
    (p) => {
      expect(() => resolveDockerfilePath('/pkg', p)).toThrow(/plain relative path/)
    },
  )

  it('no longer runs anything through a shell', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/agent-build/agent-build.service.ts'), 'utf8')
    expect(src).not.toMatch(/\bexecAsync\b|import \{[^}]*\bexec\b[^}]*\} from 'child_process'/)
  })
})
