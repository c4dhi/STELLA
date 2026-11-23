import { createHash } from 'crypto';
import {
  checkConfigSettingValue,
  configSettingsOf,
  type ConfigSetting,
} from '../agent-package/config-settings.js';

/**
 * Pure compatibility helpers for AgentConfiguration overrides against an
 * AgentType's pipelineSchema.
 *
 * These are intentionally DI-free so they can be shared by:
 *  - AgentConfigurationsService (NestJS runtime), and
 *  - prisma/seed.ts (plain node script, no Nest container).
 */

export type PipelineSchema = Record<string, unknown> | null | undefined;

/** Sparse override payload: { nodes?: {...}, thresholds?: {...} } */
export type ConfigOverrides = Record<string, unknown>;

/**
 * Validate an override payload against a pipelineSchema. Throws an Error whose
 * message explains the first incompatibility found:
 *  - a node override referencing an unknown node id,
 *  - a node value that is not a declared setting (#996): `nodes.n.x` must be
 *    declared as setting `n.x`, as a pipeline slot or in `settings:`,
 *  - a setting value that does not fit its declaration (type, range, options),
 *  - a threshold override that is unknown or outside its declared min/max range.
 *
 * Callers map the thrown Error to the appropriate transport (HTTP 400 in the
 * service, OUTDATED status in the reconciler).
 */
export function validateConfigurationAgainstSchema(
  config: ConfigOverrides,
  pipelineSchema: PipelineSchema,
): void {
  if (!pipelineSchema) return;

  const nodes = pipelineSchema.nodes as
    | Array<Record<string, unknown>>
    | undefined;
  const thresholds = pipelineSchema.thresholds as
    | Array<Record<string, unknown>>
    | undefined;

  // Validate node overrides reference known node ids.
  const configNodes = config.nodes as Record<string, unknown> | undefined;
  if (configNodes && nodes) {
    const knownNodeIds = new Set(nodes.map((n) => n.id as string));
    const settings = settingsByKey(pipelineSchema);
    for (const [nodeId, values] of Object.entries(configNodes)) {
      if (!knownNodeIds.has(nodeId)) {
        throw new Error(`Unknown node ID in configuration: ${nodeId}`);
      }
      if (values === null || values === undefined) continue;
      if (typeof values !== 'object' || Array.isArray(values)) {
        throw new Error(`Node ${nodeId} in configuration must be an object of settings`);
      }
      for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
        const key = `${nodeId}.${name}`;
        const setting = settings.get(key);
        if (!setting) {
          throw new Error(`Unknown setting in configuration: ${key} (the agent does not declare it)`);
        }
        const problem = checkConfigSettingValue(setting, value);
        if (problem) throw new Error(`Setting ${key} ${problem}`);
      }
    }
  }

  // Validate threshold overrides are known and within range.
  const configThresholds = config.thresholds as
    | Record<string, unknown>
    | undefined;
  if (configThresholds && thresholds) {
    const thresholdMap = new Map(thresholds.map((t) => [t.id as string, t]));
    for (const [key, value] of Object.entries(configThresholds)) {
      const schema = thresholdMap.get(key);
      if (!schema) {
        throw new Error(`Unknown threshold in configuration: ${key}`);
      }
      if (typeof value === 'number') {
        const min = schema.min as number | undefined;
        const max = schema.max as number | undefined;
        if (min !== undefined && value < min) {
          throw new Error(
            `Threshold ${key} value ${value} is below minimum ${min}`,
          );
        }
        if (max !== undefined && value > max) {
          throw new Error(
            `Threshold ${key} value ${value} is above maximum ${max}`,
          );
        }
      }
    }
  }
}

/**
 * Conservatively prune overrides that reference nodes, settings or thresholds
 * which no longer exist in the schema (or, for settings, never were declared). This is the only auto-mutation the reconciler performs:
 * it drops dangling references (a node/threshold the new schema removed) but
 * never clamps or rewrites values the user explicitly set. Out-of-range values
 * are left intact so re-validation flags them as OUTDATED for user review.
 *
 * Returns the (possibly) pruned overrides plus the list of removed keys.
 */
export function pruneRemovedOverrides(
  config: ConfigOverrides,
  pipelineSchema: PipelineSchema,
): { sanitized: ConfigOverrides; prunedKeys: string[] } {
  if (!pipelineSchema) return { sanitized: config, prunedKeys: [] };

  const prunedKeys: string[] = [];
  const result: ConfigOverrides = { ...config };

  const nodes = pipelineSchema.nodes as
    | Array<Record<string, unknown>>
    | undefined;
  const thresholds = pipelineSchema.thresholds as
    | Array<Record<string, unknown>>
    | undefined;

  const configNodes = config.nodes as Record<string, unknown> | undefined;
  if (configNodes && nodes) {
    const knownNodeIds = new Set(nodes.map((n) => n.id as string));
    const settings = settingsByKey(pipelineSchema);
    const kept: Record<string, unknown> = {};
    for (const [nodeId, value] of Object.entries(configNodes)) {
      if (!knownNodeIds.has(nodeId)) {
        prunedKeys.push(`nodes.${nodeId}`);
        continue;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        kept[nodeId] = value;
        continue;
      }
      // A setting the agent no longer declares, or never did, is a dangling
      // reference like a removed node: dropped, never rewritten.
      const node: Record<string, unknown> = {};
      for (const [name, v] of Object.entries(value as Record<string, unknown>)) {
        if (settings.has(`${nodeId}.${name}`)) node[name] = v;
        else prunedKeys.push(`nodes.${nodeId}.${name}`);
      }
      kept[nodeId] = node;
    }
    result.nodes = kept;
  }

  const configThresholds = config.thresholds as
    | Record<string, unknown>
    | undefined;
  if (configThresholds && thresholds) {
    const knownThresholdIds = new Set(thresholds.map((t) => t.id as string));
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(configThresholds)) {
      if (knownThresholdIds.has(key)) kept[key] = value;
      else prunedKeys.push(`thresholds.${key}`);
    }
    result.thresholds = kept;
  }

  return { sanitized: result, prunedKeys };
}

/**
 * Compare two dotted version strings numerically (e.g. "1.2.0" vs "1.10.0").
 * Returns negative if a < b, 0 if equal, positive if a > b.
 *
 * Pre-release suffixes follow semver §11: the release core (before the first "-")
 * is compared first, and a normal release outranks its pre-release
 * (1.0.0 > 1.0.0-rc1). Two pre-releases compare identifier-by-identifier — numeric
 * identifiers numerically and below alphanumerics, and a longer identifier set wins
 * when all preceding identifiers are equal.
 */
export function compareVersions(a: string, b: string): number {
  const [mainA, preA] = splitPrerelease(String(a));
  const [mainB, preB] = splitPrerelease(String(b));

  const mainCmp = compareDottedNumeric(mainA, mainB);
  if (mainCmp !== 0) return mainCmp;

  // Equal release core: a release (no pre-release) outranks its pre-release.
  if (!preA && !preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  return comparePrerelease(preA, preB);
}

/** Split "1.2.0-rc.1" into ["1.2.0", "rc.1"]; ["1.2.0", ""] when no suffix. */
function splitPrerelease(v: string): [string, string] {
  const i = v.indexOf('-');
  return i === -1 ? [v, ''] : [v.slice(0, i), v.slice(i + 1)];
}

/** Per-segment compare; numeric segments numerically, others lexically. */
function compareDottedNumeric(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? '0';
    const sb = pb[i] ?? '0';
    const na = Number(sa);
    const nb = Number(sb);
    const aNum = Number.isInteger(na);
    const bNum = Number.isInteger(nb);
    if (aNum && bNum) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/** Compare two pre-release strings ("rc.1", "beta") per semver §11. */
function comparePrerelease(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if (i >= pa.length) return -1; // a is a prefix of b → a < b
    if (i >= pb.length) return 1;
    const sa = pa[i];
    const sb = pb[i];
    const aNum = /^\d+$/.test(sa);
    const bNum = /^\d+$/.test(sb);
    if (aNum && bNum) {
      const diff = Number(sa) - Number(sb);
      if (diff !== 0) return diff;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1; // numeric identifiers rank below alphanumerics
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Whether an available compiler version satisfies a configuration's required
 * minimum. No requirement (falsy) is always satisfied. If a minimum is required
 * but the agent declares no compiler version, it cannot be guaranteed → not
 * satisfied.
 */
export function satisfiesMinCompilerVersion(
  available: string | null | undefined,
  required: string | null | undefined,
): boolean {
  if (!required) return true;
  if (!available) return false;
  return compareVersions(available, required) >= 0;
}

/**
 * Stable SHA-256 of a pipelineSchema, used by the seed to detect schema edits
 * (even when the manifest version string didn't change) so reconciliation runs
 * only when the schema actually changed.
 */
export function hashPipelineSchema(pipelineSchema: PipelineSchema): string {
  const canonical = canonicalJsonStringify(pipelineSchema ?? null);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Deterministic JSON stringify with sorted object keys. */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJsonStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`)
    .join(',')}}`;
}

/** The schema's declared settings, by `<node>.<name>` key. */
function settingsByKey(pipelineSchema: PipelineSchema): Map<string, ConfigSetting> {
  return new Map(
    configSettingsOf(pipelineSchema as Record<string, unknown> | null).map((s) => [s.key, s]),
  );
}

