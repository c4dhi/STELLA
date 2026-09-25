import * as fs from 'fs';
import * as path from 'path';
import { parseAgentManifestYaml } from '../agent-package/schemas/agent-manifest.schema';

/**
 * stella-light is deprecated, not retired (#467 follow-up).
 *
 * The distinction is load-bearing. Retiring it (validationStatus REJECTED, or
 * deleting it from agents/) would hide the type and break the three deployments
 * that already reference it. Deprecation demotes it in the gallery while
 * keeping it deployable and its saved configurations valid.
 */
describe('agent deprecation', () => {
  const agentsDir = path.resolve(__dirname, '../../agents');

  function manifest(slug: string) {
    const yaml = fs.readFileSync(path.join(agentsDir, slug, 'agent.yaml'), 'utf-8');
    const result = parseAgentManifestYaml(yaml);
    expect(result.valid).toBe(true);
    return result.manifest!;
  }

  it('marks stella-light deprecated with somewhere to go instead', () => {
    const m = manifest('stella-light-agent') as any;
    expect(m.metadata.deprecated).toBe(true);
    // A deprecation with no alternative is just a dead end for whoever reads it.
    expect(m.metadata.deprecationNote).toBeTruthy();
    expect(m.metadata.deprecationNote).toMatch(/V2/i);
  });

  it('keeps stella-v2 undeprecated', () => {
    const m = manifest('stella-v2-agent') as any;
    expect(m.metadata.deprecated).toBeFalsy();
  });

  it('does not fall back to a deprecated agent when none is specified', () => {
    // The trap this closes: agentType is optional on several paths, and the
    // default used to be stella-light — so the least-maintained agent was the
    // one you got by not choosing. Any new fallback must not be deprecated.
    const sources = [
      'src/agents/agents.service.ts',
      'src/public-projects/public-projects.service.ts',
      'src/webhooks/webhooks.service.ts',
      'src/kubernetes/kubernetes.service.ts',
    ];
    for (const rel of sources) {
      const src = fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8');
      expect(src).not.toMatch(/\|\|\s*'stella-light-agent'/);
      expect(src).not.toMatch(/DEFAULT_AGENT_TYPE',\s*'stella-light-agent'/);
    }
  });

  it('still allows deploying the deprecated agent explicitly', () => {
    // Deprecated ≠ removed: the three existing deployments must stay
    // reproducible, so the allow-list keeps it.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../agents/agents.service.ts'),
      'utf-8',
    );
    expect(src).toContain("'stella-light-agent'");
  });
});
