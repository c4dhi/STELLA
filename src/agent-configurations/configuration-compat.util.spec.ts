import {
  validateConfigurationAgainstSchema,
  pruneRemovedOverrides,
  hashPipelineSchema,
  compareVersions,
  satisfiesMinCompilerVersion,
} from './configuration-compat.util.js';

const schema = {
  nodes: [{ id: 'input_gate' }, { id: 'planner' }],
  thresholds: [{ id: 'temperature', min: 0, max: 1 }],
};

describe('validateConfigurationAgainstSchema', () => {
  it('accepts overrides that reference known nodes and in-range thresholds', () => {
    expect(() =>
      validateConfigurationAgainstSchema(
        { nodes: { input_gate: { x: 1 } }, thresholds: { temperature: 0.5 } },
        schema,
      ),
    ).not.toThrow();
  });

  it('throws on an unknown node id', () => {
    expect(() =>
      validateConfigurationAgainstSchema({ nodes: { ghost: {} } }, schema),
    ).toThrow(/Unknown node ID in configuration: ghost/);
  });

  it('throws on an unknown threshold', () => {
    expect(() =>
      validateConfigurationAgainstSchema({ thresholds: { nope: 1 } }, schema),
    ).toThrow(/Unknown threshold in configuration: nope/);
  });

  it('throws when a threshold is out of range', () => {
    expect(() =>
      validateConfigurationAgainstSchema({ thresholds: { temperature: 5 } }, schema),
    ).toThrow(/above maximum 1/);
  });

  it('is a no-op when there is no schema', () => {
    expect(() =>
      validateConfigurationAgainstSchema({ nodes: { anything: {} } }, null),
    ).not.toThrow();
  });
});

describe('pruneRemovedOverrides', () => {
  it('drops overrides for nodes/thresholds the schema no longer declares', () => {
    const { sanitized, prunedKeys } = pruneRemovedOverrides(
      {
        nodes: { input_gate: { a: 1 }, removed_node: { b: 2 } },
        thresholds: { temperature: 0.5, removed_threshold: 0.1 },
      },
      schema,
    );

    expect(sanitized.nodes).toEqual({ input_gate: { a: 1 } });
    expect(sanitized.thresholds).toEqual({ temperature: 0.5 });
    expect(prunedKeys.sort()).toEqual(
      ['nodes.removed_node', 'thresholds.removed_threshold'].sort(),
    );
  });

  it('does not clamp out-of-range values (left for re-validation to flag)', () => {
    const { sanitized, prunedKeys } = pruneRemovedOverrides(
      { thresholds: { temperature: 9 } },
      schema,
    );
    expect(sanitized.thresholds).toEqual({ temperature: 9 });
    expect(prunedKeys).toEqual([]);
  });
});

describe('hashPipelineSchema', () => {
  it('is stable regardless of key order', () => {
    const a = hashPipelineSchema({ nodes: [{ id: 'x' }], edges: [] });
    const b = hashPipelineSchema({ edges: [], nodes: [{ id: 'x' }] });
    expect(a).toBe(b);
  });

  it('changes when the schema content changes', () => {
    const a = hashPipelineSchema({ nodes: [{ id: 'x' }] });
    const b = hashPipelineSchema({ nodes: [{ id: 'y' }] });
    expect(a).not.toBe(b);
  });

  it('treats null and undefined identically', () => {
    expect(hashPipelineSchema(null)).toBe(hashPipelineSchema(undefined));
  });
});

describe('compareVersions', () => {
  it('compares release cores numerically (not lexically)', () => {
    expect(compareVersions('1.10.0', '1.2.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('ranks a release above its pre-release (semver §11)', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.1.0-rc1', '1.0.0')).toBeGreaterThan(0); // core wins first
  });

  it('orders pre-release identifiers per semver', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha')).toBeGreaterThan(0); // longer set wins
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBeLessThan(0); // numeric
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0); // numeric < alphanumeric
  });
});

describe('satisfiesMinCompilerVersion', () => {
  it('treats no requirement as always satisfied', () => {
    expect(satisfiesMinCompilerVersion(null, null)).toBe(true);
    expect(satisfiesMinCompilerVersion(null, undefined)).toBe(true);
    expect(satisfiesMinCompilerVersion('1.0.0', undefined)).toBe(true);
  });

  it('rejects when a minimum is required but none is available', () => {
    expect(satisfiesMinCompilerVersion(null, '1.0.0')).toBe(false);
  });

  it('compares available against the required floor', () => {
    expect(satisfiesMinCompilerVersion('1.2.0', '1.1.0')).toBe(true);
    expect(satisfiesMinCompilerVersion('1.0.0', '1.0.0')).toBe(true);
    expect(satisfiesMinCompilerVersion('1.0.0', '1.1.0')).toBe(false);
    // a pre-release compiler does not satisfy a stable floor
    expect(satisfiesMinCompilerVersion('1.1.0-rc1', '1.1.0')).toBe(false);
  });
});
