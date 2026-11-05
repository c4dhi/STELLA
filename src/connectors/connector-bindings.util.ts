/**
 * Connector bindings: which of the deploying user's connectors an agent
 * instance may call, under which handle. Pure functions so the rules are
 * testable without a database.
 */

export const CONNECTOR_HANDLE_REGEX = /^[a-z][a-z0-9-]{0,39}$/;

/** One slot an agent declares in agent.yaml (x-stella-connectors). */
export interface ConnectorSlot {
  slot: string;
  kind: 'mcp';
  required?: boolean;
  label: string;
  description?: string;
  requiredTools?: string[];
}

/** Stored on AgentInstance.connectorBindings. */
export interface ConnectorBinding {
  handle: string;
  connectorId: string;
  slot?: string;
}

export interface BindingRequest {
  connectorId: string;
  handle?: string;
  slot?: string;
}

/** A connector the deployer may bind: their own, or one shared with the project. */
export interface AvailableConnector {
  id: string;
  handle: string;
  name: string;
  toolsSnapshot: unknown;
}

export class BindingValidationError extends Error {}

function toolNames(snapshot: unknown): string[] | null {
  if (!Array.isArray(snapshot)) return null;
  return snapshot
    .map((t) => (t && typeof t === 'object' ? (t as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string');
}

/**
 * Turn what the deploy request asked for into stored bindings.
 *
 * - every connector must be in `available`: the deployer's own, or shared with the session's project;
 * - a slot must be declared by the agent type and bound at most once;
 * - every required slot must be bound;
 * - a slot's requiredTools must be in the connector's last tool snapshot (when it has one);
 * - handles default to the slot name, then the connector's own handle, and must be unique.
 *
 * Extra connectors without a slot are always allowed.
 */
export function resolveConnectorBindings(
  requests: BindingRequest[] | undefined,
  slots: ConnectorSlot[] | null | undefined,
  available: AvailableConnector[],
): ConnectorBinding[] {
  const declared = new Map((slots ?? []).map((s) => [s.slot, s]));
  const availableById = new Map(available.map((c) => [c.id, c]));
  const bindings: ConnectorBinding[] = [];
  const handles = new Set<string>();
  const boundSlots = new Set<string>();

  for (const req of requests ?? []) {
    const connector = availableById.get(req.connectorId);
    if (!connector) {
      throw new BindingValidationError(
        `Connector ${req.connectorId} is neither yours nor shared with this project`,
      );
    }
    let slot: ConnectorSlot | undefined;
    if (req.slot) {
      slot = declared.get(req.slot);
      if (!slot) throw new BindingValidationError(`This agent declares no connector slot "${req.slot}"`);
      if (boundSlots.has(req.slot)) throw new BindingValidationError(`Connector slot "${req.slot}" is bound twice`);
      boundSlots.add(req.slot);
      const available = toolNames(connector.toolsSnapshot);
      const missing = available
        ? (slot.requiredTools ?? []).filter((t) => !available.includes(t))
        : [];
      if (missing.length > 0) {
        throw new BindingValidationError(
          `Connector "${connector.name}" lacks tools the "${slot.label}" slot needs: ${missing.join(', ')}`,
        );
      }
    }
    const handle = req.handle ?? req.slot ?? connector.handle;
    if (!CONNECTOR_HANDLE_REGEX.test(handle)) {
      throw new BindingValidationError(`Connector handle "${handle}" must be lowercase letters, digits and hyphens`);
    }
    if (handles.has(handle)) throw new BindingValidationError(`Connector handle "${handle}" is used twice`);
    handles.add(handle);
    bindings.push(req.slot ? { handle, connectorId: connector.id, slot: req.slot } : { handle, connectorId: connector.id });
  }

  const missingRequired = (slots ?? []).filter((s) => s.required && !boundSlots.has(s.slot));
  if (missingRequired.length > 0) {
    throw new BindingValidationError(
      `This agent needs a connector for: ${missingRequired.map((s) => s.label).join(', ')}`,
    );
  }
  return bindings;
}

/**
 * The connector slots an agent type declares: configSchema['x-stella-connectors'],
 * validated by the manifest parser at upload/seed. Read defensively anyway.
 */
export function connectorSlotsOf(configSchema: unknown): ConnectorSlot[] {
  const raw =
    configSchema && typeof configSchema === 'object'
      ? (configSchema as Record<string, unknown>)['x-stella-connectors']
      : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is ConnectorSlot =>
      !!s && typeof s === 'object' && typeof (s as any).slot === 'string' && typeof (s as any).label === 'string',
  );
}

/** Read stored bindings defensively: the column is plain Json. */
export function readBindings(value: unknown): ConnectorBinding[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (b): b is ConnectorBinding =>
      !!b && typeof b === 'object' && typeof (b as any).handle === 'string' && typeof (b as any).connectorId === 'string',
  );
}

/**
 * Stored bindings as a deploy request again, for an agent recreated from a
 * saved snapshot (wake after auto-pause). Deploy re-checks each one, so a
 * connector that was deleted or unshared since is refused, not silently kept.
 */
export function bindingRequestsFrom(value: unknown): BindingRequest[] {
  return readBindings(value).map((b) =>
    b.slot ? { connectorId: b.connectorId, handle: b.handle, slot: b.slot } : { connectorId: b.connectorId, handle: b.handle },
  );
}
