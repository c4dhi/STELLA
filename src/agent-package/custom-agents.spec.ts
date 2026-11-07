import AdmZip from 'adm-zip'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { AgentPackageService } from './agent-package.service.js'
import { ManifestValidator } from './validators/manifest.validator.js'
import { DockerfileValidator } from './validators/dockerfile.validator.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CUSTOM_AGENTS = path.resolve(__dirname, '../../custom-agents')

/** Zip a folder the way the custom-agents README tells users to: its contents at the zip root. */
function zipFolder(dir: string): Buffer {
  const zip = new AdmZip()
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name.startsWith('.')) continue
      const relPath = path.posix.join(rel, entry.name)
      if (entry.isDirectory()) walk(relPath)
      else zip.addFile(relPath, fs.readFileSync(path.join(dir, relPath)))
    }
  }
  walk('')
  return zip.toBuffer()
}

const packages = fs.existsSync(CUSTOM_AGENTS)
  ? fs
      .readdirSync(CUSTOM_AGENTS, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(CUSTOM_AGENTS, e.name, 'agent.yaml')))
      .map((e) => e.name)
  : []

// The agents in custom-agents/ are not seeded. Users download them and
// upload them through the UI, so each one must pass exactly the validation an
// upload goes through. A package that fails here would be turned away there.
describe('custom-agents packages pass upload validation', () => {
  const service = new AgentPackageService(new ManifestValidator(), new DockerfileValidator(), null as any)

  it('ships at least the ELIAS-Interviewer', () => {
    expect(packages).toContain('elias-interviewer')
  })

  it.each(packages)('%s', async (name) => {
    const result = await service.validatePackage(zipFolder(path.join(CUSTOM_AGENTS, name)))
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
    expect(result.manifest?.metadata.slug).toBe(name)
  })
})
