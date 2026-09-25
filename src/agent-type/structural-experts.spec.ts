import * as fs from 'fs';
import * as path from 'path';
import { parseAgentManifestYaml } from '../agent-package/schemas/agent-manifest.schema';

/**
 * Two experts are structural rather than assessment (#467).
 *
 * task_extraction is how a plan is executed; companion_router is how companion
 * mode is executed. Neither is something an operator opts into — deleting
 * either does not leave a working system, it removes the mechanism the mode is
 * made of. So both ride on the capability for their mode, and both are kept out
 * of the arbitration pool.
 */
describe('structural experts', () => {
  const agentsDir = path.resolve(__dirname, '../../agents');

  function manifest(slug: string) {
    const yaml = fs.readFileSync(path.join(agentsDir, slug, 'agent.yaml'), 'utf-8');
    const result = parseAgentManifestYaml(yaml);
    expect(result.valid).toBe(true);
    return result.manifest!;
  }

  function expertConfig(slug: string, name: string) {
    return JSON.parse(
      fs.readFileSync(path.join(agentsDir, slug, 'config', 'experts', `${name}.json`), 'utf-8'),
    );
  }

  it('declares a capability for every mode it implements', () => {
    const caps = manifest('stella-v2-agent').capabilities as string[];
    expect(caps).toEqual(expect.arrayContaining(['plans', 'experts', 'companion']));
  });

  it('ships the companion router disabled', () => {
    // The shipped default is what a plan-following deployment gets if the
    // structural write is ever lost, so it must be the safe direction: off.
    expect(expertConfig('stella-v2-agent', 'companion_router').enabled).toBe(false);
  });

  it('gives the router the tools companion mode is built from', () => {
    const router = expertConfig('stella-v2-agent', 'companion_router');
    expect(router.can_call_functions).toBe(true);
    expect(router.tools).toEqual(['list_activities', 'start_activity', 'end_activity']);
  });

  it('lets the deploy mode, not the saved configuration, decide the router', () => {
    // The guarantee is ordering: the structural write must come AFTER
    // _apply_pipeline_config, or a saved config carrying
    // `companion_router: {enabled: false}` silently disables companion mode.
    const agent = fs.readFileSync(
      path.join(agentsDir, 'stella-v2-agent/src/stella_v2_agent/agent.py'),
      'utf-8',
    );
    const applyPipeline = agent.indexOf('self._apply_pipeline_config(pipeline_config)');
    const structural = agent.indexOf('"companion_router": {"enabled": self._companion_mode}');
    expect(applyPipeline).toBeGreaterThan(-1);
    expect(structural).toBeGreaterThan(applyPipeline);
  });
});
