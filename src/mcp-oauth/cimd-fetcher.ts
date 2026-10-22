import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { OAuthClientMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';

const TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;

export class CimdError extends Error {}

/** IPv4/IPv6 ranges a metadata URL must not point into: loopback, private, link-local, metadata services. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a >= 224) return false; // multicast, reserved
    return true;
  }
  const v6 = address.toLowerCase();
  if (v6 === '::1' || v6 === '::') return false;
  if (v6.startsWith('fc') || v6.startsWith('fd')) return false; // unique local
  if (
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb')
  )
    return false;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicAddress(mapped[1]);
  return true;
}

export interface CimdDeps {
  lookup: (host: string) => Promise<{ address: string }[]>;
  fetch: typeof fetch;
}

const defaultDeps: CimdDeps = {
  lookup: (host) => dnsLookup(host, { all: true }),
  fetch: (input, init) => fetch(input, init),
};

/**
 * Fetch a Client ID Metadata Document: the client_id is an https URL that
 * serves the client's metadata. The URL comes from whoever starts a sign-in,
 * so the fetch is fenced: https only, public addresses only, no redirects,
 * a short timeout and a size cap. The document must name itself as client_id.
 */
export async function fetchClientMetadataDocument(
  clientId: string,
  deps: CimdDeps = defaultDeps,
) {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new CimdError('client_id is not a URL');
  }
  if (url.protocol !== 'https:')
    throw new CimdError('client metadata URL must use https');
  if (url.username || url.password || url.hash)
    throw new CimdError(
      'client metadata URL must not carry credentials or a fragment',
    );

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host }]
    : await deps.lookup(host).catch(() => []);
  if (addresses.length === 0)
    throw new CimdError('client metadata host does not resolve');
  if (!addresses.every((a) => isPublicAddress(a.address)))
    throw new CimdError('client metadata host is not public');

  let response: Response;
  try {
    response = await deps.fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new CimdError('client metadata document could not be fetched');
  }
  if (!response.ok)
    throw new CimdError(`client metadata document returned ${response.status}`);

  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES)
    throw new CimdError('client metadata document is too large');
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES)
    throw new CimdError('client metadata document is too large');

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CimdError('client metadata document is not JSON');
  }
  if ((json as { client_id?: unknown })?.client_id !== clientId) {
    throw new CimdError(
      'client metadata document does not name itself as client_id',
    );
  }
  const parsed = OAuthClientMetadataSchema.safeParse(json);
  if (!parsed.success)
    throw new CimdError(
      'client metadata document is not valid client metadata',
    );
  return parsed.data;
}
