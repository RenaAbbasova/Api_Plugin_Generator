import { describe, expect, it } from 'vitest';
import { decodeLogo, MAX_LOGO_BYTES, pluginRequestSchema, testApiSchema } from '@/lib/schema';

const valid = { platform: 'chrome', pluginName: 'My Plugin', description: 'Shows data', apiUrl: 'https://api.example.com/v1/items?x=1', apiMethod: 'GET', apiKey: 'abc', headers: { 'X-Team': 'blue' }, visualizeData: true };
const ok = (v: unknown) => pluginRequestSchema.safeParse(v).success;
const withField = (patch: Record<string, unknown>) => ({ ...valid, ...patch });

describe('plugin request validation', () => {
  it('accepts a normal request', () => expect(ok(valid)).toBe(true));
  it('defaults optional fields', () => {
    const parsed = pluginRequestSchema.parse({ platform: 'wordpress', pluginName: 'Abc', description: '', apiUrl: 'https://a.example.com', apiMethod: 'GET' });
    expect(parsed.apiKey).toBe('');
    expect(parsed.headers).toEqual({});
    expect(parsed.visualizeData).toBe(false);
  });
  it.each([
    ['path traversal in the name', { pluginName: '../tmp/victim' }],
    ['quote in the name', { pluginName: "x'); system('id'); //" }],
    ['name that is only symbols', { pluginName: '***' }],
    ['name too short', { pluginName: 'a' }],
    ['name too long', { pluginName: 'a'.repeat(61) }],
    ['method injection', { apiMethod: 'get($u,$a);system("whoami");//' }],
    ['lower-case method', { apiMethod: 'get' }],
    ['unknown platform', { platform: 'safari' }],
    ['ftp url', { apiUrl: 'ftp://example.com/x' }],
    ['javascript url', { apiUrl: 'javascript:alert(1)' }],
    ['url with credentials', { apiUrl: 'https://user:pw@example.com/' }],
    ['url with a newline', { apiUrl: 'https://example.com/\nX: y' }],
    ['description with a newline', { description: 'a\nb' }],
    ['description too long', { description: 'a'.repeat(133) }],
    ['api key with a newline', { apiKey: 'a\r\nInjected: 1' }],
    ['forbidden header', { headers: { Host: 'evil.example' } }],
    ['header name with a space', { headers: { 'X Bad': 'v' } }],
    ['header value with a newline', { headers: { 'X-A': 'v\r\nX-B: w' } }],
    ['too many headers', { headers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-${i}`, 'v'])) }],
    ['api key and Authorization header together', { apiKey: 'k', headers: { authorization: 'Basic abc' } }],
  ])('rejects %s', (_label, patch) => expect(ok(withField(patch))).toBe(false));

  it('allows an Authorization header when there is no API key', () => {
    expect(ok(withField({ apiKey: '', headers: { Authorization: 'Basic abc' } }))).toBe(true);
  });
  it('test-api schema applies the same URL and header rules', () => {
    expect(testApiSchema.safeParse({ apiUrl: 'http://127.0.0.1/', apiMethod: 'GET' }).success).toBe(true); // syntax is fine; the network layer blocks it
    expect(testApiSchema.safeParse({ apiUrl: 'file:///etc/passwd', apiMethod: 'GET' }).success).toBe(false);
    expect(testApiSchema.safeParse({ apiUrl: 'https://a.example.com', apiMethod: 'DELETE' }).success).toBe(false);
  });
});

describe('logo', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
  it('accepts a PNG, with or without the data: prefix', () => {
    expect(decodeLogo(png.toString('base64'))?.length).toBe(png.length);
    expect(decodeLogo('data:image/png;base64,' + png.toString('base64'))?.length).toBe(png.length);
  });
  it('rejects things that are not PNG images', () => {
    expect(decodeLogo(Buffer.from('<svg onload=alert(1)>').toString('base64'))).toBeNull();
    expect(decodeLogo(Buffer.from('GIF89a....').toString('base64'))).toBeNull();
    expect(decodeLogo('not base64!!')).toBeNull();
    expect(decodeLogo('')).toBeNull();
  });
  it('rejects a PNG over the size limit', () => {
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(MAX_LOGO_BYTES, 1)]);
    expect(decodeLogo(big.toString('base64'))).toBeNull();
  });
});
