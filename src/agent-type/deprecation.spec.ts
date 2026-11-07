import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseAgentManifestYaml } from '../agent-package/schemas/agent-manifest.schema.js';
import { FALLBACK_AGENT_TYPE } from '../agents/default-agent-type.js';
import { builtInImageConfig } from '../agent-image/agent-image.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    // one you got by not choosing. Every path now asks default-agent-type.ts.
    expect(FALLBACK_AGENT_TYPE).not.toBe('stella-light-agent');
    expect((manifest(FALLBACK_AGENT_TYPE) as any).metadata.deprecated).toBeFalsy();
  });

  it('still allows deploying the deprecated agent explicitly', () => {
    // Deprecated ≠ removed: the three existing deployments must stay
    // reproducible. Any APPROVED type deploys (assertDeployableAgentType), and
    // the seed keeps stella-light APPROVED. A built-in's image comes from its
    // own folder and manifest, so what must survive is the folder.
    expect(builtInImageConfig(manifest('stella-light-agent'))).toEqual({
      imageName: 'stella-light-agent',
      dockerfilePath: 'agents/stella-light-agent/Dockerfile',
      contextPath: '.',
      tag: 'latest',
    });

    const agentsSrc = fs.readFileSync(
      path.resolve(__dirname, '../agents/agents.service.ts'),
      'utf-8',
    );
    expect(agentsSrc).toContain('assertDeployableAgentType(');
    expect(agentsSrc).not.toContain('allowedAgentTypes');
  });
});
