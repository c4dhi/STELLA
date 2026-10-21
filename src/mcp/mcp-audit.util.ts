const SECRET_KEY =
  /pass(word)?|secret|token|api[-_]?key|authorization|credential/i;
const MAX_STRING = 200;
const MAX_ARRAY = 20;
const MAX_DEPTH = 4;
const MAX_JSON = 2048;

function summarize(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)`
      : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH)
    return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => summarize(v, depth + 1));
    return value.length > MAX_ARRAY
      ? [...head, `… (${value.length} items)`]
      : head;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      SECRET_KEY.test(k) ? '[redacted]' : summarize(v, depth + 1),
    ]),
  );
}

/**
 * Tool arguments as stored in McpAuditLog: secret-looking keys redacted, long
 * strings and arrays cut short, at most about 2 KB in all.
 */
export function summarizeToolArgs(args: unknown): Record<string, unknown> {
  const summary = summarize(args ?? {}, 0);
  const object =
    summary && typeof summary === 'object' && !Array.isArray(summary)
      ? (summary as Record<string, unknown>)
      : { value: summary };
  if (JSON.stringify(object).length <= MAX_JSON) return object;
  return { truncated: true, keys: Object.keys(object) };
}
