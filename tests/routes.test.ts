import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { unzipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { POST as generate } from '@/app/api/generate-plugin/route';
import { POST as preview } from '@/app/api/preview-plugin/route';
import { POST as testApi } from '@/app/api/test-api/route';

const call = (handler: (r: Request) => Promise<Response>, body: unknown, raw = false) =>
  handler(new Request('http://localhost/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ? (body as string) : JSON.stringify(body) }));

const good = { platform: 'chrome', pluginName: 'My Plugin', description: 'A plugin', apiUrl: 'https://api.example.com/v1', apiMethod: 'GET', apiKey: 'k', headers: { 'X-A': 'b' }, visualizeData: false };
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(30, 7)]).toString('base64');

describe('POST /api/generate-plugin', () => {
  it('returns a zip named after a safe slug', async () => {
    const res = await call(generate, { ...good, pluginName: 'My Plugin (v2)' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="my-plugin-v2.zip"');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['README.txt', 'manifest.json', 'popup.css', 'popup.html', 'popup.js']);
  });
  it('includes the logo when it is a real PNG', async () => {
    const res = await call(generate, { ...good, logoPng: png });
    expect(Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())))).toContain('icon.png');
  });
  it('rejects a logo that is not a PNG', async () => {
    const res = await call(generate, { ...good, logoPng: Buffer.from('<svg onload=alert(1)>').toString('base64') });
    expect(res.status).toBe(400);
  });

  describe('the attacks that worked against the original code', () => {
    it('path traversal in the plugin name no longer touches the file system', async () => {
      const victim = path.join(os.tmpdir(), 'victim_important_test.zip');
      fs.writeFileSync(victim, 'important data');
      const res = await call(generate, { ...good, pluginName: '../victim_important_test' });
      expect(res.status).toBe(400);                                  // rejected by validation
      expect(fs.readFileSync(victim, 'utf8')).toBe('important data'); // and nothing was written or deleted
      fs.rmSync(victim);
    });
    it('a plugin name that is accepted never becomes a path', async () => {
      const res = await call(generate, { ...good, pluginName: 'a b.c (d)' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="[a-z0-9-]+\.zip"$/);
    });
    it('method injection is rejected', async () => {
      expect((await call(generate, { ...good, platform: 'wordpress', apiMethod: 'get($u,$a);system("whoami");//' })).status).toBe(400);
    });
    it('code in the URL, description, API key or headers cannot break out of the generated string', async () => {
      const res = await call(generate, { ...good, platform: 'wordpress', apiUrl: "https://a.example.com/x?q='); system('id'); //", apiKey: "k'); system('id'); //", headers: { 'X-A': "v'=>system('id'),'Y" } });
      expect(res.status).toBe(200);
      const php = new TextDecoder().decode(Object.values(unzipSync(new Uint8Array(await res.arrayBuffer()))).find((f) => new TextDecoder().decode(f.slice(0, 5)) === '<?php')!);
      expect(php).not.toMatch(/^[^']*system\(/m);                      // 'system(' only ever appears inside a quoted string
      expect(php).toContain("\\'); system(\\'id\\'); //");              // ...with its quotes escaped
    });
  });

  it.each([
    ['invalid JSON', '{not json', true],
    ['an array', [1, 2], false],
    ['an empty object', {}, false],
  ])('answers 400 to %s', async (_l, body, raw) => expect((await call(generate, body, raw)).status).toBe(400));
  it('answers 413 to a huge body', async () => {
    expect((await call(generate, { ...good, description: 'x'.repeat(800_000) })).status).toBe(413);
  });
  it('lists what is wrong', async () => {
    const res = await call(generate, { ...good, pluginName: '', apiUrl: 'nope' });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.details.join(' ')).toMatch(/pluginName/);
    expect(json.details.join(' ')).toMatch(/apiUrl/);
  });
});

describe('POST /api/preview-plugin', () => {
  it('returns the real text files of the plugin', async () => {
    const res = await call(preview, { ...good, platform: 'wordpress' });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.slug).toBe('my-plugin');
    expect(json.files.map((f: { path: string }) => f.path)).toContain('my-plugin/my-plugin.php');
    expect(json.files.find((f: { path: string }) => f.path.endsWith('.php')).content).toContain("'https://api.example.com/v1'");
  });
  it('validates like the generator', async () => expect((await call(preview, { ...good, pluginName: '../x' })).status).toBe(400));
});

describe('POST /api/test-api', () => {
  let server: http.Server;
  let base: string;
  const previous = process.env.ALLOW_PRIVATE_URLS;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') { res.statusCode = 301; res.setHeader('Location', 'http://169.254.169.254/'); return res.end(); }
      if (req.url === '/text') { res.setHeader('Content-Type', 'text/plain'); return res.end('hello'); }
      if (req.url === '/fail') { res.statusCode = 500; return res.end('{"error":"boom"}'); }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ internal_secret: 'only-reachable-from-inside', auth: req.headers.authorization ?? null }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  afterEach(() => { if (previous === undefined) delete process.env.ALLOW_PRIVATE_URLS; else process.env.ALLOW_PRIVATE_URLS = previous; });

  it('REFUSES to fetch an internal service (the SSRF that worked against the original code)', async () => {
    delete process.env.ALLOW_PRIVATE_URLS;
    const res = await call(testApi, { apiUrl: `${base}/admin`, apiMethod: 'GET', apiKey: '', headers: {} });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('only-reachable-from-inside');
  });
  it.each(['http://169.254.169.254/latest/meta-data/', 'http://localhost:3000/', 'http://[::1]/', 'http://2130706433/', 'http://10.0.0.1/'])(
    'refuses %s', async (apiUrl) => {
      delete process.env.ALLOW_PRIVATE_URLS;
      expect((await call(testApi, { apiUrl, apiMethod: 'GET' })).status).toBe(403);
    });
  it('works for local development when ALLOW_PRIVATE_URLS=true, forwarding the key', async () => {
    process.env.ALLOW_PRIVATE_URLS = 'true';
    const res = await call(testApi, { apiUrl: `${base}/data`, apiMethod: 'GET', apiKey: 'abc', headers: {} });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ status: 200, ok: true, body: { internal_secret: 'only-reachable-from-inside', auth: 'Bearer abc' } });
  });
  it('does not follow redirects, even to metadata addresses', async () => {
    process.env.ALLOW_PRIVATE_URLS = 'true';
    expect((await call(testApi, { apiUrl: `${base}/redirect`, apiMethod: 'GET' })).status).toBe(502);
  });
  it('shows non-JSON answers as text and reports API errors without failing', async () => {
    process.env.ALLOW_PRIVATE_URLS = 'true';
    expect((await (await call(testApi, { apiUrl: `${base}/text`, apiMethod: 'GET' })).json()).body).toBe('hello');
    const failed = await (await call(testApi, { apiUrl: `${base}/fail`, apiMethod: 'GET' })).json();
    expect(failed).toMatchObject({ status: 500, ok: false, body: { error: 'boom' } });
  });
  it('rejects invalid input', async () => {
    expect((await call(testApi, { apiUrl: 'file:///etc/passwd', apiMethod: 'GET' })).status).toBe(400);
    expect((await call(testApi, { apiUrl: 'https://a.example.com', apiMethod: 'GET', headers: { Host: 'evil' } })).status).toBe(400);
  });
});
