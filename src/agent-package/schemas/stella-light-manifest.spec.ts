import * as fs from 'fs';
import * as path from 'path';
import { parseAgentManifestYaml } from './agent-manifest.schema';

/**
 * Guards the stella-light-agent manifest after it was made configurable (ticket #240
 * follow-up): it must declare a valid pipelineSchema so the Agent Configurator offers
 * it and saved configurations validate/reconcile like stella-v2.
 */
describe('stella-light-agent manifest', () => {
  const manifestPath = path.resolve(
    __dirname,
    '../../../agents/stella-light-agent/agent.yaml',
  );
  const result = parseAgentManifestYaml(fs.readFileSync(manifestPath, 'utf8'));

  it('parses successfully against the strict schema', () => {
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('declares a configurable pipelineSchema with the response node', () => {
    const schema = result.manifest?.pipelineSchema as
      | { nodes: Array<{ id: string; slots: Array<{ id: string }> }>; thresholds: Array<{ id: string }> }
      | undefined;
    expect(schema).toBeDefined();

    const response = schema!.nodes.find((n) => n.id === 'response');
    expect(response).toBeDefined();
    const slotIds = response!.slots.map((s) => s.id);
    expect(slotIds).toEqual(
      expect.arrayContaining(['conversation_style', 'model', 'temperature', 'max_tokens']),
    );

    // The response node governs HOW the agent speaks, never WHO it is (#467).
    // Both of these once carried identity; either one back on this node is a
    // second source competing with the persona chosen at deploy, and it would
    // win, because a saved configuration is applied after the persona resolves.
    expect(slotIds).not.toContain('system_prompt');
    expect(slotIds).not.toContain('persona');

    expect(schema!.thresholds.map((t) => t.id)).toContain('history_limit');
  });

  it('marks the config schema as configurator-enabled', () => {
    const configSchema = result.manifest?.configSchema as Record<string, unknown> | undefined;
    expect(configSchema?.['x-stella-supports-configurator']).toBe(true);
  });

  it('declares a runtime-variable palette and a prompt-compiler version', () => {
    const manifest = result.manifest as
      | { runtimeVariables?: Array<{ name: string; parametric?: boolean }>; promptCompiler?: { version: string } }
      | undefined;
    const names = (manifest?.runtimeVariables ?? []).map((v) => v.name);
    // Mirrors the SDK placeholder compiler's resolvable set.
    expect(names).toEqual(
      expect.arrayContaining([
        'plan', 'current_focus', 'pending_deliverables', 'collected_deliverables',
        'turns_without_progress', 'current_state', 'progress_percentage',
        'processing_mode', 'history', 'user_message',
      ]),
    );
    expect(manifest?.runtimeVariables?.find((v) => v.name === 'history')?.parametric).toBe(true);
    expect(manifest?.promptCompiler?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
