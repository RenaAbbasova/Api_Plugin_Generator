import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { guardedLookup, isPrivateAddress, safeFetch, SafeFetchError, validateTargetUrl } from '@/lib/ssrf';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2002:7f00:1::1', '2002:a9fe:a9fe::',
    'not-an-ip', '', '1.2.3', '999.1.1.1',
  ])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '11.0.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '2002:0808:0808::1'])(
    'allows %s', (ip) => expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe('validateTargetUrl', () => {
  it.each([
    'http://localhost/x', 'http://LOCALHOST:3000/', 'http://localhost./', 'http://app.localhost/', 'http://127.0.0.1/', 'http://[::1]/',
    'http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://0/', 'http://169.254.169.254/latest/meta-data/',
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://192.168.0.10/', 'http://10.0.0.5:8080/', 'http://printer.local/',
    'http://metadata.google.internal/', 'http://intranet/', 'http://db.corp/',
  ])('blocks %s', (url) => expect(() => validateTargetUrl(url, false)).toThrow(SafeFetchError));

  it.each(['ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/', 'https://user:pw@example.com/', 'not a url'])(
    'rejects %s as an invalid URL', (url) => expect(() => validateTargetUrl(url, false)).toThrow(/URL|http|username/i),
  );
  it.each(['https://api.example.com/v1?x=1', 'http://example.com:8080/', 'https://8.8.8.8/', 'https://[2606:4700:4700::1111]/'])(
    'allows %s', (url) => expect(validateTargetUrl(url, false).href).toBeTruthy(),
  );
  it('allows private targets only when explicitly enabled', () => {
    expect(validateTargetUrl('http://127.0.0.1:3000/', true).hostname).toBe('127.0.0.1');
  });
});

describe('guardedLookup (the address used for the real connection)', () => {
  it('refuses a host name that resolves to a private address (DNS rebinding)', async () => {
    const spy = vi.spyOn(dns, 'lookup').mockImplementation(((_h: string, _o: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) => cb(null, [{ address: '127.0.0.1', family: 4 }])) as never);
    const result = await new Promise<{ err: Error | null }>((resolve) => guardedLookup(false)('rebind.example.com', {}, (err) => resolve({ err })));
    expect(result.err?.message).toBe('BLOCKED_ADDRESS');
    spy.mockRestore();
  });
  it('refuses when ANY of several answers is private', async () => {
    const spy = vi.spyOn(dns, 'lookup').mockImplementation(((_h: string, _o: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) => cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }])) as never);
    const result = await new Promise<{ err: Error | null }>((resolve) => guardedLookup(false)('mixed.example.com', { all: true }, (err) => resolve({ err })));
    expect(result.err?.message).toBe('BLOCKED_ADDRESS');
    spy.mockRestore();
  });
  it('lets a public address through', async () => {
    const spy = vi.spyOn(dns, 'lookup').mockImplementation(((_h: string, _o: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) => cb(null, [{ address: '93.184.216.34', family: 4 }])) as never);
    const result = await new Promise<{ err: Error | null; address: unknown }>((resolve) => guardedLookup(false)('ok.example.com', {}, (err, address) => resolve({ err, address })));
    expect(result.err).toBeNull();
    expect(result.address).toBe('93.184.216.34');
    spy.mockRestore();
  });
});

describe('safeFetch against a local test server', () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      if (url.startsWith('/json')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ hello: 'world', auth: req.headers.authorization ?? null, custom: req.headers['x-team'] ?? null, method: req.method })); }
      else if (url.startsWith('/redirect')) { res.statusCode = 302; res.setHeader('Location', 'http://169.254.169.254/latest/meta-data/'); res.end(); }
      else if (url.startsWith('/slow')) { setTimeout(() => res.end('late'), 2000); }
      else if (url.startsWith('/big')) { res.end('x'.repeat(300_000)); }
      else if (url.startsWith('/text')) { res.setHeader('Content-Type', 'text/plain'); res.end('plain text'); }
      else { res.statusCode = 404; res.end('nope'); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('blocks the local server by default', async () => {
    await expect(safeFetch({ url: `${base}/json`, method: 'GET', headers: {}, allowPrivate: false })).rejects.toMatchObject({ code: 'blocked' });
  });
  it('fetches when private targets are allowed, sending the headers and method', async () => {
    const result = await safeFetch({ url: `${base}/json`, method: 'POST', headers: { Authorization: 'Bearer k', 'X-Team': 'blue' }, allowPrivate: true });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual({ hello: 'world', auth: 'Bearer k', custom: 'blue', method: 'POST' });
  });
  it('does not follow redirects (the target could be an internal address)', async () => {
    await expect(safeFetch({ url: `${base}/redirect`, method: 'GET', headers: {}, allowPrivate: true })).rejects.toMatchObject({ code: 'redirect' });
  });
  it('times out', async () => {
    await expect(safeFetch({ url: `${base}/slow`, method: 'GET', headers: {}, allowPrivate: true, timeoutMs: 300 })).rejects.toMatchObject({ code: 'timeout' });
  });
  it('refuses a response over the size limit', async () => {
    await expect(safeFetch({ url: `${base}/big`, method: 'GET', headers: {}, allowPrivate: true, maxBytes: 100_000 })).rejects.toMatchObject({ code: 'too_large' });
  });
  it('returns non-JSON bodies as text', async () => {
    const result = await safeFetch({ url: `${base}/text`, method: 'GET', headers: {}, allowPrivate: true });
    expect(result.text).toBe('plain text');
  });
  it('reports an unreachable host without leaking internals', async () => {
    await expect(safeFetch({ url: 'http://127.0.0.1:1/', method: 'GET', headers: {}, allowPrivate: true, timeoutMs: 2000 })).rejects.toMatchObject({ code: 'network', message: expect.not.stringContaining('127.0.0.1') });
  });
});
