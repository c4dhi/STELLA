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

/** The four bytes of a dotted IPv4 address, or null. */
function ipv4Bytes(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null;
  return ip.split('.').map(Number);
}

/** The sixteen bytes of an IPv6 address (any spelling, dotted tail allowed), or null. */
function ipv6Bytes(ip: string): number[] | null {
  const addr = ip.split('%')[0];
  if (isIP(addr) !== 6) return null;
  let head = addr;
  let tail: number[] = [];
  const lastColon = addr.lastIndexOf(':');
  const dotted = ipv4Bytes(addr.slice(lastColon + 1));
  if (dotted) {
    head = addr.slice(0, lastColon + 1) + '0:0';
    tail = dotted;
  }
  const [left, right] = head.includes('::')
    ? head.split('::')
    : [head, undefined];
  const parse = (part: string | undefined) =>
    part ? part.split(':').filter(Boolean) : [];
  const l = parse(left);
  const r = parse(right);
  const groups =
    right === undefined
      ? l
      : [...l, ...Array(8 - l.length - r.length).fill('0'), ...r];
  if (groups.length !== 8) return null;
  const bytes = groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function isPrivateIpv4Bytes([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/**
 * Whether an address is anything but a public unicast address. Works on bytes,
 * not strings, so every spelling of an IPv6 address is caught, including
 * IPv4-mapped (::ffff:127.0.0.1, which Node writes as ::ffff:7f00:1),
 * IPv4-compatible, NAT64 (64:ff9b::/96) and 6to4 (2002::/16) forms, whose
 * embedded IPv4 address is checked too. Anything that doesn't parse counts as
 * private.
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ipv4Bytes(ip);
  if (v4) return isPrivateIpv4Bytes(v4);
  const b = ipv6Bytes(ip);
  if (!b) return true;
  const zero = (from: number, to: number) =>
    b.slice(from, to).every((x) => x === 0);
  // ::/96 holds ::, ::1 and the deprecated IPv4-compatible form; nothing public.
  if (zero(0, 12)) return true;
  // ::ffff:0:0/96, IPv4-mapped
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff)
    return isPrivateIpv4Bytes(b.slice(12));
  // 64:ff9b::/96 and 64:ff9b:1::/48, NAT64
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b)
    return isPrivateIpv4Bytes(b.slice(12));
  // 2002::/16, 6to4: the IPv4 address sits in bytes 2-5
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIpv4Bytes(b.slice(2, 6));
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local
  if (b[0] === 0xff) return true; // multicast
  if (b[0] === 0x01 && zero(1, 8)) return true; // 100::/64 discard
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8)
    return true; // documentation
  return false;
}

const PRIVATE_NAME = /(^|\.)(localhost|local|internal|svc)$|\.svc\.cluster\./i;

export function isPrivateHostname(host: string): boolean {
  return PRIVATE_NAME.test(host.replace(/\.$/, ''));
}

/**
 * Refuse URLs that point into the cluster or the host's own network. A
 * connector URL is user input fetched by the backend, so without this any user
 * could make STELLA call its own internal services. Set
 * CONNECTORS_ALLOW_PRIVATE_HOSTS=true for local development against localhost.
 *
 * This early check gives a clear error at save/test time. It is not the guard
 * that matters: DNS can answer differently a moment later, so the address is
 * checked again inside the connection itself (see connector-fetch.util.ts).
 */
export async function assertPublicHost(
  urlString: string,
  allowPrivate: boolean,
): Promise<void> {
  if (allowPrivate) return;
  const host = new URL(urlString).hostname.replace(/^\[|\]$/g, '');
  if (isPrivateHostname(host)) {
    throw new Error(
      `${host} is a private address; connectors must use a public server`,
    );
  }
  const addresses = isIP(host)
    ? [host]
    : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(
      `${host} resolves to a private address; connectors must use a public server`,
    );
  }
}
