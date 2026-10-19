import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Safe outbound requests for the "Test API" feature.
 *
 * The server must never be usable to reach services that only the server can reach
 * (localhost, the private network, cloud metadata endpoints...). This module:
 *   1. accepts only http(s) URLs without credentials and rejects obviously internal host names,
 *   2. rejects private / reserved IP addresses, including IPv4 hidden inside IPv6 addresses,
 *   3. checks the address that is really used for the connection (so a host name that changes its
 *      answer between the check and the connection, "DNS rebinding", cannot slip through),
 *   4. never follows redirects (a redirect could point to an internal address),
 *   5. applies a timeout and a size limit to the response.
 */

export type SafeFetchErrorCode = 'invalid_url' | 'blocked' | 'redirect' | 'timeout' | 'too_large' | 'network';

export class SafeFetchError extends Error {
  constructor(public readonly code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

class BlockedAddressError extends Error {
  constructor() {
    super('BLOCKED_ADDRESS');
    this.name = 'BlockedAddressError';
  }
}

// ---------------------------------------------------------------- address classification

const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

function isPrivateIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = ipv4ToInt(base);
    return value >= start && value < start + size;
  });
}

/** Expands an IPv6 address into eight 16-bit groups, accepting an embedded dotted IPv4 tail. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.split('%')[0].toLowerCase();
  const tail = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const v4 = tail[1].split('.').map(Number);
    if (v4.some((n) => n > 255)) return null;
    text = text.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function embeddedV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True when the address must not be reached from the server. Unknown / malformed input counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind !== 6) return true;
  const g = ipv6Groups(ip);
  if (!g) return true;
  const allZeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroUpTo(7) && (g[7] === 0 || g[7] === 1)) return true;                                  // :: and ::1
  if (allZeroUpTo(5) && g[5] === 0xffff) return isPrivateIPv4(embeddedV4(g[6], g[7]));            // ::ffff:a.b.c.d (mapped)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateIPv4(embeddedV4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPrivateIPv4(embeddedV4(g[1], g[2]));                              // 6to4
  if ((g[0] & 0xe000) !== 0x2000) return true;                                                   // only global unicast 2000::/3
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0x0db8)) return true;                          // Teredo and documentation ranges
  return false;
}

// ---------------------------------------------------------------- URL validation

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home.arpa', '.intranet', '.corp'];

export function privateUrlsAllowed(): boolean {
  return process.env.ALLOW_PRIVATE_URLS === 'true';
}

/** Parses and checks a URL. Throws SafeFetchError('invalid_url' | 'blocked'). */
export function validateTargetUrl(raw: string, allowPrivate = privateUrlsAllowed()): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError('invalid_url', 'The API URL is not valid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SafeFetchError('invalid_url', 'Only http and https URLs are allowed.');
  if (url.username || url.password) throw new SafeFetchError('invalid_url', 'URLs with a username or password are not allowed.');
  if (allowPrivate) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const literal = net.isIP(host) !== 0;
  if (literal) {
    if (isPrivateAddress(host)) throw new SafeFetchError('blocked', 'That address is private or reserved and cannot be tested.');
  } else if (!host.includes('.') || host === 'localhost' || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new SafeFetchError('blocked', 'Internal host names cannot be tested.');
  }
  return url;
}

// ---------------------------------------------------------------- the request itself

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** DNS lookup used for the real connection: it refuses to hand back private addresses. */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, [], 0);
      const list = addresses as dns.LookupAddress[];
      if (!allowPrivate && list.some((entry) => isPrivateAddress(entry.address))) {
        return callback(new BlockedAddressError() as NodeJS.ErrnoException, [], 0);
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

export interface SafeFetchInput {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivate?: boolean;
}

export interface SafeFetchResult {
  status: number;
  contentType: string;
  text: string;
}

export async function safeFetch(input: SafeFetchInput): Promise<SafeFetchResult> {
  const allowPrivate = input.allowPrivate ?? privateUrlsAllowed();
  const timeoutMs = input.timeoutMs ?? 8000;
  const maxBytes = input.maxBytes ?? 1_000_000;
  const url = validateTargetUrl(input.url, allowPrivate);

  const agent = new Agent({ connect: { lookup: guardedLookup(allowPrivate) } });
  try {
    const response = await undiciFetch(url, {
      method: input.method,
      headers: input.headers,
      redirect: 'manual',
      dispatcher: agent,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status >= 300 && response.status < 400) {
      throw new SafeFetchError('redirect', `The API answered with a redirect (HTTP ${response.status}). Use the final URL instead.`);
    }

    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SafeFetchError('too_large', `The response is larger than ${Math.round(maxBytes / 1000)} KB.`);
      }
      chunks.push(value);
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', text };
  } catch (error) {
    if (error instanceof SafeFetchError) throw error;
    const cause = (error as { cause?: unknown })?.cause;
    if (cause instanceof BlockedAddressError || (cause as Error | undefined)?.message === 'BLOCKED_ADDRESS') {
      throw new SafeFetchError('blocked', 'That host resolves to a private or reserved address and cannot be tested.');
    }
    if ((error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError') {
      throw new SafeFetchError('timeout', `The API did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw new SafeFetchError('network', 'Could not reach the API. Check the URL and your connection.');
  } finally {
    await agent.close().catch(() => undefined);
  }
}
