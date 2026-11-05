import { promises as dns } from 'dns';
import { isIP } from 'net';

/**
 * Clean up a connector URL the way users paste it.
 *
 * - Only http(s). http is allowed for local development but most servers need https.
 * - Repeated slashes in the path collapse ("https://host//mcp" is common).
 * - A trailing slash is dropped: behind nginx, "/mcp/" is often answered with a
 *   307 to an http:// URL, and the redirected request loses the Authorization
 *   header, so the server replies 401 and the token looks wrong when it isn't.
 * - Fragments are removed; query strings are kept (some servers carry a key there).
 */
export function normalizeConnectorUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('URL must start with https:// or http://');
  }
  if (url.username || url.password) {
    throw new Error('Put the credential in the token field, not in the URL');
  }
  let path = url.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  url.pathname = path;
  url.hash = '';
  if (path === '/') return `${url.origin}${url.search}`;
  return url.toString();
}

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIpv4(ip);
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivateIpv4(lower.slice(7));
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80')
  );
}

/**
 * Refuse URLs that point into the cluster or the host's own network. A
 * connector URL is user input fetched by the backend, so without this any user
 * could make STELLA call its own internal services. Set
 * CONNECTORS_ALLOW_PRIVATE_HOSTS=true for local development against localhost.
 */
export async function assertPublicHost(
  urlString: string,
  allowPrivate: boolean,
): Promise<void> {
  if (allowPrivate) return;
  const host = new URL(urlString).hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.svc') || host.includes('.svc.cluster.')) {
    throw new Error(`${host} is a private address; connectors must use a public server`);
  }
  const addresses = isIP(host)
    ? [host]
    : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivateIp)) {
    throw new Error(`${host} resolves to a private address; connectors must use a public server`);
  }
}
