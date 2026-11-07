import { lookup as dnsLookup, LookupAddress, LookupOptions } from 'dns';
import { isIP } from 'net';
import { Agent, fetch as undiciFetch } from 'undici';
import { isPrivateAddress, isPrivateHostname } from './connector-url.util.js';

/** Raised from inside the socket's DNS lookup; classify() maps it to `blocked_host`. */
export class BlockedHostError extends Error {
  readonly code = 'ERR_CONNECTOR_BLOCKED_HOST';
  constructor(host: string) {
    super(
      `${host} resolves to a private address; connectors must use a public server`,
    );
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** dns.lookup with `all: true`; injectable for tests. */
export type Resolver = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (
    err: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
) => void;

/**
 * A DNS lookup for sockets that refuses private results. Because it runs as the
 * socket's own lookup, the address that was checked is the address that is
 * connected to: a host can't answer publicly for an earlier check and privately
 * for the request (DNS rebinding).
 */
export function makeGuardedLookup(
  resolve: Resolver = dnsLookup as unknown as Resolver,
) {
  return function guardedLookup(
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ): void {
    if (isPrivateHostname(hostname)) {
      callback(new BlockedHostError(hostname), '');
      return;
    }
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '');
      const list = addresses as LookupAddress[];
      if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
        return callback(new BlockedHostError(hostname), '');
      }
      if (options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

export type FetchLike = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * fetch for connector traffic. Literal IP hosts never go through a lookup, so
 * they are checked here; every other host is checked in guardedLookup.
 */
export function createGuardedFetch(agent: Agent): FetchLike {
  return async (url, init) => {
    const host = new URL(String(url)).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && isPrivateAddress(host)) throw new BlockedHostError(host);
    const response = await undiciFetch(url, {
      ...(init as Record<string, unknown>),
      dispatcher: agent,
    } as Parameters<typeof undiciFetch>[1]);
    return response as unknown as Response;
  };
}

export function createGuardedAgent(resolve?: Resolver): Agent {
  return new Agent({
    connect: { lookup: makeGuardedLookup(resolve) as never },
  });
}

/** Whether an error (or anything in its cause chain) came from the host guard. */
export function isBlockedHostError(error: unknown): BlockedHostError | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    if (current instanceof BlockedHostError) return current;
    if ((current as { code?: string }).code === 'ERR_CONNECTOR_BLOCKED_HOST')
      return current as BlockedHostError;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
